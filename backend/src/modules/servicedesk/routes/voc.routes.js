/**
 * Phase 51 — Voice of Customer (VOC)
 * Auto-trigger after: commissioning / service visit / AMC visit / project closure
 * NPS, CSAT, classification, action tracking, VOC dashboard
 */
import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const cid = req => companyOf(req);
const uid = req => req.user?.userId ?? req.user?.id ?? null;

const TRIGGER_EVENTS = ['commissioning', 'service_visit', 'amc_visit', 'project_closure', 'manual'];

// =============================================================================
// SURVEY TEMPLATES
// =============================================================================

router.get('/surveys', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM voc_surveys WHERE company_id = $1 ORDER BY trigger_event, name`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/surveys', verifyToken, async (req, res) => {
  try {
    const { name, trigger_event, questions, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (trigger_event && !TRIGGER_EVENTS.includes(trigger_event)) {
      return res.status(400).json({ error: `trigger_event must be one of: ${TRIGGER_EVENTS.join(', ')}` });
    }
    const { rows } = await pool.query(
      `INSERT INTO voc_surveys (company_id, name, trigger_event, questions, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cid(req), name, trigger_event || 'manual', JSON.stringify(questions || defaultQuestions(trigger_event)), is_active !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/surveys/:id', verifyToken, async (req, res) => {
  try {
    const { name, trigger_event, questions, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE voc_surveys
          SET name = COALESCE($1, name),
              trigger_event = COALESCE($2, trigger_event),
              questions = COALESCE($3, questions),
              is_active = COALESCE($4, is_active)
        WHERE id = $5 AND company_id = $6 RETURNING *`,
      [name, trigger_event, questions ? JSON.stringify(questions) : null, is_active, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Survey not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// VOC RESPONSES
// =============================================================================

// GET /voc/responses — list responses with filters
router.get('/responses', verifyToken, async (req, res) => {
  try {
    const { trigger_event, classification, is_actioned, from_date, to_date } = req.query;
    let q = `SELECT * FROM voc_responses WHERE company_id = $1`;
    const params = [cid(req)];
    if (trigger_event) { params.push(trigger_event); q += ` AND trigger_event = $${params.length}`; }
    if (classification) { params.push(classification); q += ` AND classification = $${params.length}`; }
    if (is_actioned !== undefined) { params.push(is_actioned === 'true'); q += ` AND is_actioned = $${params.length}`; }
    if (from_date) { params.push(from_date); q += ` AND submitted_at >= $${params.length}`; }
    if (to_date) { params.push(to_date); q += ` AND submitted_at <= $${params.length}`; }
    q += ' ORDER BY submitted_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /voc/responses — submit response (can be called internally or from portal)
router.post('/responses', async (req, res) => {
  try {
    const {
      company_id, survey_id, trigger_event, trigger_ref_id, customer_name, customer_email,
      project_id, ticket_id, commissioning_id, rating, nps_score, category,
      response_data, suggestions, improvement_ideas, new_feature_requests
    } = req.body;
    if (!company_id) return res.status(400).json({ error: 'company_id is required' });
    if (nps_score !== undefined && (nps_score < 0 || nps_score > 10)) {
      return res.status(400).json({ error: 'nps_score must be 0-10' });
    }

    const sentiment = nps_score !== undefined ? (nps_score >= 9 ? 'promoter' : nps_score >= 7 ? 'passive' : 'detractor') : null;
    const classification = category || classifyFeedback(suggestions, improvement_ideas, new_feature_requests);

    const { rows } = await pool.query(
      `INSERT INTO voc_responses
         (company_id, survey_id, trigger_event, trigger_ref_id, customer_name, customer_email,
          project_id, ticket_id, commissioning_id, rating, nps_score, category,
          sentiment, response_data, suggestions, improvement_ideas, new_feature_requests, classification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [company_id, survey_id, trigger_event, trigger_ref_id, customer_name, customer_email,
       project_id, ticket_id, commissioning_id, rating, nps_score, category,
       sentiment, JSON.stringify(response_data || {}), suggestions, improvement_ideas,
       new_feature_requests, classification]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /voc/responses/:id/action — mark as actioned
router.put('/responses/:id/action', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE voc_responses
          SET is_actioned = true, actioned_by = $1, actioned_at = NOW()
        WHERE id = $2 AND company_id = $3 RETURNING *`,
      [req.user?.name || req.user?.email, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Response not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /voc/responses/:id/classify
router.put('/responses/:id/classify', verifyToken, async (req, res) => {
  try {
    const { classification } = req.body;
    const { rows } = await pool.query(
      `UPDATE voc_responses SET classification = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
      [classification, req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Response not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// VOC DASHBOARD
// =============================================================================

router.get('/dashboard', verifyToken, async (req, res) => {
  try {
    const [kpis, npsBreakdown, byEvent, byClassification, topComplaints, topSuggestions, trend] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total_responses,
               ROUND(AVG(nps_score)::NUMERIC,2) AS avg_nps,
               ROUND(AVG(rating)::NUMERIC,2) AS avg_rating,
               COUNT(CASE WHEN nps_score >= 9 THEN 1 END) AS promoters,
               COUNT(CASE WHEN nps_score BETWEEN 7 AND 8 THEN 1 END) AS passives,
               COUNT(CASE WHEN nps_score <= 6 THEN 1 END) AS detractors,
               COUNT(CASE WHEN is_actioned = false THEN 1 END) AS unactioned
          FROM voc_responses WHERE company_id = $1 AND submitted_at >= NOW() - INTERVAL '90 days'
      `, [cid(req)]),
      pool.query(`SELECT sentiment, COUNT(*) AS cnt FROM voc_responses WHERE company_id = $1 AND sentiment IS NOT NULL GROUP BY sentiment`, [cid(req)]),
      pool.query(`SELECT trigger_event, COUNT(*) AS cnt, ROUND(AVG(nps_score)::NUMERIC,2) AS avg_nps FROM voc_responses WHERE company_id = $1 GROUP BY trigger_event ORDER BY cnt DESC`, [cid(req)]),
      pool.query(`SELECT classification, COUNT(*) AS cnt FROM voc_responses WHERE company_id = $1 AND classification IS NOT NULL GROUP BY classification ORDER BY cnt DESC`, [cid(req)]),
      pool.query(`SELECT suggestions FROM voc_responses WHERE company_id = $1 AND suggestions IS NOT NULL AND sentiment = 'detractor' ORDER BY submitted_at DESC LIMIT 10`, [cid(req)]),
      pool.query(`SELECT improvement_ideas FROM voc_responses WHERE company_id = $1 AND improvement_ideas IS NOT NULL ORDER BY submitted_at DESC LIMIT 10`, [cid(req)]),
      pool.query(`SELECT TO_CHAR(submitted_at,'YYYY-MM') AS month, ROUND(AVG(nps_score)::NUMERIC,2) AS avg_nps, COUNT(*) AS responses FROM voc_responses WHERE company_id = $1 AND submitted_at >= NOW()-INTERVAL '12 months' GROUP BY month ORDER BY month`, [cid(req)]),
    ]);

    const totalP = kpis.rows[0];
    const totalR = parseInt(totalP.promoters) + parseInt(totalP.detractors) + parseInt(totalP.passives);
    const nps = totalR > 0 ? Math.round(((parseInt(totalP.promoters) - parseInt(totalP.detractors)) / totalR) * 100) : 0;

    res.json({
      kpis: { ...totalP, nps_score: nps },
      nps_breakdown: npsBreakdown.rows,
      by_trigger_event: byEvent.rows,
      by_classification: byClassification.rows,
      top_complaints: topComplaints.rows.map(r => r.suggestions).filter(Boolean),
      top_suggestions: topSuggestions.rows.map(r => r.improvement_ideas).filter(Boolean),
      trend: trend.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Internal helpers ──────────────────────────────────────────────────────────
function classifyFeedback(suggestions, improvements, features) {
  const text = `${suggestions || ''} ${improvements || ''} ${features || ''}`.toLowerCase();
  if (/product|panel|equipment|relay|transformer|quality/.test(text)) return 'Product';
  if (/service|engineer|technician|support|response|time/.test(text)) return 'Service';
  if (/manual|document|report|certificate/.test(text)) return 'Documentation';
  if (/training|guide|tutorial|how to/.test(text)) return 'Training';
  if (/app|portal|software|feature|button|system/.test(text)) return 'Software';
  return 'General';
}

function defaultQuestions(trigger_event) {
  const base = [
    { id: 1, text: 'How likely are you to recommend us to a colleague or friend?', type: 'nps', required: true },
    { id: 2, text: 'Overall satisfaction with this interaction', type: 'rating', scale: 5, required: true },
    { id: 3, text: 'What did we do well?', type: 'text', required: false },
    { id: 4, text: 'What could we improve?', type: 'text', required: false },
  ];
  if (trigger_event === 'commissioning') {
    base.push({ id: 5, text: 'Engineer professionalism and punctuality', type: 'rating', scale: 5 });
    base.push({ id: 6, text: 'Site cleanliness after commissioning', type: 'rating', scale: 5 });
    base.push({ id: 7, text: 'Quality of documentation handed over', type: 'rating', scale: 5 });
  }
  if (trigger_event === 'service_visit') {
    base.push({ id: 5, text: 'Was the issue resolved on first visit?', type: 'boolean' });
    base.push({ id: 6, text: 'Speed of response from complaint to visit', type: 'rating', scale: 5 });
  }
  return base;
}

export default router;
