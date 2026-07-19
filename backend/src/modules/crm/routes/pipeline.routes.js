import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

// ─── Pipeline Stages ──────────────────────────────────────────────────────────

router.get('/pipeline-stages', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM crm_pipeline_stages
       WHERE company_id = $1 ORDER BY sort_order ASC, id ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pipeline-stages', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, color = '#6B7280', probability = 0 } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Stage name is required' });
    }
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
       FROM crm_pipeline_stages WHERE company_id = $1`,
      [companyId]
    );
    const nextOrder = maxRes.rows[0].next_order;
    const stage_key = name.trim().toLowerCase().replace(/\s+/g, '_');
    const result = await pool.query(
      `INSERT INTO crm_pipeline_stages
         (company_id, name, stage_key, sort_order, color, probability)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, stage_key) DO UPDATE
         SET name = EXCLUDED.name, color = EXCLUDED.color,
             probability = EXCLUDED.probability, is_active = true
       RETURNING *`,
      [companyId, name.trim(), stage_key, nextOrder, color, Math.min(100, Math.max(0, parseInt(probability) || 0))]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pipeline-stages/reorder', requirePermission('crm', 'edit'), async (req, res) => {
  const companyId = companyOf(req);
  const { ordered_ids } = req.body;
  if (!Array.isArray(ordered_ids) || ordered_ids.length === 0) {
    return res.status(400).json({ error: 'ordered_ids array is required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ordered_ids.length; i++) {
      await client.query(
        `UPDATE crm_pipeline_stages SET sort_order = $1
         WHERE id = $2 AND company_id = $3`,
        [i + 1, ordered_ids[i], companyId]
      );
    }
    await client.query('COMMIT');
    const result = await client.query(
      `SELECT * FROM crm_pipeline_stages WHERE company_id = $1 ORDER BY sort_order ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/pipeline-stages/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    // Block delete if opportunities exist in this stage
    const stageRes = await pool.query(
      `SELECT stage_key FROM crm_pipeline_stages WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (stageRes.rowCount === 0) return res.status(404).json({ error: 'Stage not found' });
    const stageKey = stageRes.rows[0].stage_key;
    const oppCheck = await pool.query(
      `SELECT 1 FROM opportunities WHERE LOWER(stage) = $1 AND deleted_at IS NULL LIMIT 1`,
      [stageKey]
    );
    if (oppCheck.rowCount > 0) {
      return res.status(409).json({ error: 'Cannot delete a stage that has active opportunities' });
    }
    await pool.query(
      `DELETE FROM crm_pipeline_stages WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    res.json({ message: 'Stage deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Lead Scoring Rules ───────────────────────────────────────────────────────

// Alias: /scoring-rules → same data as /lead-scoring-rules
router.get('/scoring-rules', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM crm_lead_scoring_rules WHERE company_id = $1 ORDER BY created_at ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/lead-scoring-rules', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM crm_lead_scoring_rules WHERE company_id = $1 ORDER BY created_at ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/lead-scoring-rules', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { field, operator = 'equals', value, score_delta } = req.body;
    if (!field || score_delta === undefined) {
      return res.status(400).json({ error: 'field and score_delta are required' });
    }
    const result = await pool.query(
      `INSERT INTO crm_lead_scoring_rules (company_id, field, operator, value, score_delta)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [companyId, field, operator, value || null, parseInt(score_delta) || 0]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/lead-scoring-rules/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { field, operator, value, score_delta, is_active } = req.body;
    const result = await pool.query(
      `UPDATE crm_lead_scoring_rules
       SET field       = COALESCE($1, field),
           operator    = COALESCE($2, operator),
           value       = COALESCE($3, value),
           score_delta = COALESCE($4, score_delta),
           is_active   = COALESCE($5, is_active)
       WHERE id = $6 AND company_id = $7 RETURNING *`,
      [field ?? null, operator ?? null, value ?? null,
       score_delta !== undefined ? parseInt(score_delta) : null,
       is_active !== undefined ? Boolean(is_active) : null,
       req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/lead-scoring-rules/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `DELETE FROM crm_lead_scoring_rules WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ message: 'Rule deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Assignment Rules ─────────────────────────────────────────────────────────

router.get('/assignment-rules', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM crm_assignment_rules WHERE company_id = $1 ORDER BY priority ASC, created_at ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/assignment-rules', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, condition_field = 'source', condition_value = '', assign_to_name = '', priority = 10, is_active = true } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Rule name is required' });
    }
    const result = await pool.query(
      `INSERT INTO crm_assignment_rules
         (company_id, name, condition_field, condition_value, assign_to_name, priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [companyId, name.trim(), condition_field, condition_value, assign_to_name, parseInt(priority) || 10, Boolean(is_active)]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/assignment-rules/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, condition_field, condition_value, assign_to_name, priority, is_active } = req.body;
    const result = await pool.query(
      `UPDATE crm_assignment_rules
       SET name              = COALESCE($1, name),
           condition_field   = COALESCE($2, condition_field),
           condition_value   = COALESCE($3, condition_value),
           assign_to_name    = COALESCE($4, assign_to_name),
           priority          = COALESCE($5, priority),
           is_active         = COALESCE($6, is_active)
       WHERE id = $7 AND company_id = $8 RETURNING *`,
      [name ?? null, condition_field ?? null, condition_value ?? null, assign_to_name ?? null,
       priority !== undefined ? parseInt(priority) : null,
       is_active !== undefined ? Boolean(is_active) : null,
       req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/assignment-rules/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `DELETE FROM crm_assignment_rules WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ message: 'Rule deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Win/Loss Reasons ─────────────────────────────────────────────────────────

router.get('/win-loss-reasons', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `SELECT * FROM crm_win_loss_reasons WHERE company_id = $1 ORDER BY type, created_at ASC`,
      [companyId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/win-loss-reasons', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { type, reason } = req.body;
    if (!type || !reason) {
      return res.status(400).json({ error: 'type and reason are required' });
    }
    if (!['win', 'loss'].includes(type)) {
      return res.status(400).json({ error: 'type must be win or loss' });
    }
    const result = await pool.query(
      `INSERT INTO crm_win_loss_reasons (company_id, type, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, type, reason) DO UPDATE SET is_active = true
       RETURNING *`,
      [companyId, type, reason.trim()]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/win-loss-reasons/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { reason, is_active } = req.body;
    const result = await pool.query(
      `UPDATE crm_win_loss_reasons
       SET reason    = COALESCE($1, reason),
           is_active = COALESCE($2, is_active)
       WHERE id = $3 AND company_id = $4 RETURNING *`,
      [reason ?? null, is_active !== undefined ? Boolean(is_active) : null,
       req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reason not found' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/win-loss-reasons/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      `DELETE FROM crm_win_loss_reasons WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reason not found' });
    res.json({ message: 'Reason deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRM Settings are handled exclusively in crm.routes.js to avoid duplicate endpoint conflicts.

// ─── Win/Loss Analysis from opportunities table ───────────────────────────────

router.get('/win-loss-analysis', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = companyId != null ? [companyId] : [];
    const cw = companyId != null ? 'AND company_id = $1' : '';

    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(stage) IN ('won','lost'))                          AS total,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'won')                                    AS won,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'lost')                                   AS lost,
        COALESCE(AVG(expected_value) FILTER (WHERE LOWER(stage) = 'won'), 0)            AS avg_deal_size,
        COALESCE(AVG(
          EXTRACT(EPOCH FROM (closed_date - created_at)) / 86400
        ) FILTER (WHERE LOWER(stage) = 'won' AND closed_date IS NOT NULL), 0)           AS avg_cycle_days
      FROM opportunities
      WHERE deleted_at IS NULL ${cw}
    `, params);
    const s = summaryResult.rows[0];

    // Loss reasons from win_loss_reasons captures on stage change
    const lossResult = await pool.query(`
      SELECT COALESCE(notes, 'Other') AS reason, COUNT(*) AS count
      FROM opportunity_stage_history
      WHERE LOWER(to_stage) = 'lost' ${cw ? 'AND company_id = $1' : ''}
      GROUP BY COALESCE(notes, 'Other') ORDER BY count DESC LIMIT 20
    `, params).catch(() => ({ rows: [] }));
    const totalLost = parseInt(s.lost) || 1;
    const loss_reasons = lossResult.rows.map(r => ({
      reason: r.reason,
      count: parseInt(r.count),
      pct: parseFloat(((parseInt(r.count) / totalLost) * 100).toFixed(1)),
    }));

    // Monthly win/loss trend (12 months)
    const monthlyResult = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(closed_date, updated_at)), 'Mon YYYY') AS month,
             DATE_TRUNC('month', COALESCE(closed_date, updated_at)) AS month_start,
             COUNT(*) FILTER (WHERE LOWER(stage) = 'won')  AS won,
             COUNT(*) FILTER (WHERE LOWER(stage) = 'lost') AS lost
      FROM opportunities
      WHERE deleted_at IS NULL
        AND LOWER(stage) IN ('won','lost')
        AND COALESCE(closed_date, updated_at) >= NOW() - INTERVAL '12 months'
        ${cw}
      GROUP BY DATE_TRUNC('month', COALESCE(closed_date, updated_at))
      ORDER BY month_start ASC
    `, params).catch(() => ({ rows: [] }));
    const monthly = monthlyResult.rows.map(r => {
      const won = parseInt(r.won) || 0;
      const lost = parseInt(r.lost) || 0;
      const total = won + lost;
      return { month: r.month, won, lost, rate: total > 0 ? parseFloat(((won / total) * 100).toFixed(1)) : 0 };
    });

    // Stage conversion from pipeline stages
    const stageConvResult = await pool.query(`
      SELECT stage, COUNT(*) AS count
      FROM opportunities WHERE deleted_at IS NULL ${cw}
      GROUP BY stage ORDER BY MIN(id) ASC
    `, params).catch(() => ({ rows: [] }));
    const countMap = {};
    stageConvResult.rows.forEach(r => {
      countMap[(r.stage || '').toLowerCase()] = parseInt(r.count) || 0;
    });
    const stageConversionPairs = [
      { from: 'prospecting',  to: 'qualification' },
      { from: 'qualification', to: 'proposal' },
      { from: 'proposal',     to: 'negotiation' },
      { from: 'negotiation',  to: 'won' },
    ];
    const stage_conversion = stageConversionPairs.map(pair => {
      const fromCount = countMap[pair.from] || 0;
      const toCount   = countMap[pair.to]   || 0;
      return {
        stage: `${pair.from.charAt(0).toUpperCase() + pair.from.slice(1)}→${pair.to.charAt(0).toUpperCase() + pair.to.slice(1)}`,
        rate: fromCount > 0 ? parseFloat(((toCount / fromCount) * 100).toFixed(1)) : 0,
      };
    });

    res.json({
      data: {
        total:          parseInt(s.total)          || 0,
        won:            parseInt(s.won)            || 0,
        lost:           parseInt(s.lost)           || 0,
        avg_deal_size:  parseFloat(parseFloat(s.avg_deal_size  || 0).toFixed(2)),
        avg_cycle_days: Math.round(parseFloat(s.avg_cycle_days || 0)),
        stage_conversion, loss_reasons, monthly,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
