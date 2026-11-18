import { Router } from 'express';
import pool from '../shared/db.js';
import { companyOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
// Authorization. This router previously carried NONE — server.js mounts it with
// verifyToken only, so all 26 routes below (the whole résumé/candidate database,
// talent pools, agency commercial terms, the question bank) were readable AND
// writable by any authenticated user of any role, including roles whose
// role_permissions row sets recruitment can_view = false. Its sibling
// recruitment.routes.js has always gated every route, which is precisely what
// made this easy to miss. Same module key ('recruitment') and same four actions,
// so the existing matrix already covers every role that reaches these pages.
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { ensureDefaultInterviewQuestions } from './defaultInterviewQuestions.js';

const router = Router();

const view   = requirePermission('recruitment', 'view');
const add    = requirePermission('recruitment', 'add');
const edit   = requirePermission('recruitment', 'edit');
const remove = requirePermission('recruitment', 'delete');

/** Seed the company's default bank on first read; a seeding failure never blocks the read. */
async function seedBankOnFirstUse(companyId) {
  try { await ensureDefaultInterviewQuestions(companyId); }
  catch (e) { console.error('[talent] default interview-question seed failed:', e.message); }
}

// ── Helper ────────────────────────────────────────────────────────────────────
const getCid = (req) => req.scope?.company_id ?? companyOf(req);

// ─────────────────────────────────────────────────────────────────────────────
// RECRUITMENT AGENCIES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/talent/agencies
router.get('/agencies', view, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const companyId = getCid(req);
    const r = await pool.query(`
      SELECT
        a.id,
        COALESCE(a.agency_name, '') AS name,
        a.contact_person,
        a.email, a.phone, a.website,
        COALESCE(a.specializations, '[]'::jsonb) AS specializations,
        a.fee_percentage,
        a.payment_terms,
        a.agreement_start, a.agreement_end,
        COALESCE(a.is_active, true) AS is_active,
        a.notes, a.city, a.created_at,
        COUNT(DISTINCT c.id)::int AS total_candidates,
        COUNT(DISTINCT CASE WHEN c.current_stage = 'hired' THEN c.id END)::int AS hired_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN c.current_stage = 'hired' THEN c.id END) * 100.0 /
          NULLIF(COUNT(DISTINCT c.id), 0), 1
        ) AS success_rate
      FROM recruitment_agencies a
      LEFT JOIN candidates c ON c.source_agency_id = a.id
        AND ($1::int IS NULL OR c.company_id = $1)
      WHERE ($1::int IS NULL OR a.company_id = $1)
        AND ($2 = '' OR a.agency_name ILIKE '%' || $2 || '%'
             OR a.contact_person ILIKE '%' || $2 || '%')
      GROUP BY a.id
      ORDER BY hired_count DESC NULLS LAST, a.agency_name
    `, [companyId, search]);
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agency fees (recruitment_agency_fees) ───────────────────────────────────
// One row is written when an agency-sourced candidate becomes an employee
// (recruitment.repository autoCreateEmployeeFromCandidate). These two routes
// let the recruiter track it to payment. Literal paths, declared before
// /agencies/:id.
router.get('/agencies/fees', view, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, a.agency_name, c.full_name AS candidate_name,
              e.name AS employee_name, e.office_id AS employee_code, e.joining_date
         FROM recruitment_agency_fees f
         LEFT JOIN recruitment_agencies a ON a.id = f.agency_id
         LEFT JOIN candidates c ON c.id = f.candidate_id
         LEFT JOIN employees e ON e.id = f.employee_id
        WHERE f.company_id = $1
          AND ($2::int IS NULL OR f.agency_id = $2::int)
        ORDER BY f.created_at DESC`,
      [getCid(req), req.query.agency_id ? parseInt(req.query.agency_id, 10) : null]);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const FEE_STATUSES = ['pending', 'invoiced', 'paid', 'waived'];
router.put('/agencies/fees/:id', edit, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid fee id' });
    const b = req.body || {};
    if (b.status !== undefined && !FEE_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `Status must be one of: ${FEE_STATUSES.join(', ')}.` });
    }
    const num = (v) => (v === '' || v == null ? null : Number(v));
    for (const k of ['fee_percentage', 'fee_amount', 'annual_ctc']) {
      if (b[k] !== undefined && b[k] !== '' && b[k] !== null && !(Number(b[k]) >= 0)) {
        return res.status(400).json({ error: `${k.replace(/_/g, ' ')} must be a positive number.` });
      }
    }
    if (b.status === 'paid' && !b.paid_on) b.paid_on = new Date().toISOString().slice(0, 10);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM recruitment_agency_fees WHERE id = $1 AND company_id = $2`, [id, getCid(req)]);
    if (!before) return res.status(404).json({ error: 'Fee not found' });
    const { rows: [row] } = await pool.query(
      `UPDATE recruitment_agency_fees SET
          status         = COALESCE($3, status),
          fee_percentage = CASE WHEN $4::boolean THEN $5::numeric ELSE fee_percentage END,
          fee_amount     = CASE WHEN $6::boolean THEN $7::numeric ELSE fee_amount END,
          invoice_no     = CASE WHEN $8::boolean THEN $9 ELSE invoice_no END,
          paid_on        = CASE WHEN $10::boolean THEN $11::date ELSE paid_on END,
          notes          = CASE WHEN $12::boolean THEN $13 ELSE notes END,
          updated_at     = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, getCid(req), b.status ?? null,
       b.fee_percentage !== undefined, num(b.fee_percentage),
       b.fee_amount !== undefined, num(b.fee_amount),
       b.invoice_no !== undefined, b.invoice_no || null,
       b.paid_on !== undefined, b.paid_on || null,
       b.notes !== undefined, b.notes || null]);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: id, recordType: 'agency_fee', action: 'update', oldData: before, newData: row, req });
    res.json({ data: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/talent/agencies
router.post('/agencies', add, async (req, res) => {
  try {
    const {
      name, contact_person, email, phone, website,
      specializations, fee_percentage, payment_terms,
      agreement_start, agreement_end, is_active, notes, city,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const companyId = getCid(req);
    const r = await pool.query(`
      INSERT INTO recruitment_agencies (
        company_id, agency_name, contact_person, email, phone, website,
        specializations, fee_percentage, payment_terms,
        agreement_start, agreement_end, is_active, notes, city
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      companyId,
      name,
      contact_person || null,
      email || null,
      phone || null,
      website || null,
      specializations ? JSON.stringify(specializations) : '[]',
      fee_percentage != null ? parseFloat(fee_percentage) : null,
      payment_terms || null,
      agreement_start || null,
      agreement_end || null,
      is_active !== false,
      notes || null,
      city || null,
    ]);
    res.status(201).json({ data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/talent/agencies/:id
router.put('/agencies/:id', edit, captureBefore('recruitment_agencies'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const {
      name, contact_person, email, phone, website,
      specializations, fee_percentage, payment_terms,
      agreement_start, agreement_end, is_active, notes, city,
    } = req.body;
    // Every column is COALESCE'd against its own value, so a field the caller did
    // not send keeps what it had. Nine of these were previously assigned raw,
    // which made this a full replace masquerading as a patch: the Deactivate
    // button in RecruitmentAgencies.jsx sends {is_active:false} and nothing else,
    // so one click nulled the agency's email, phone, website, fee percentage,
    // payment terms, agreement dates, city and notes — real contract data, with
    // no warning and no undo. `is_active` stays a plain assignment because it is
    // the one field an explicit `false` must be able to write; the three-way
    // check below distinguishes "sent false" from "not sent".
    const r = await pool.query(`
      UPDATE recruitment_agencies SET
        agency_name      = COALESCE($3, agency_name),
        contact_person   = COALESCE($4, contact_person),
        email            = COALESCE($5, email),
        phone            = COALESCE($6, phone),
        website          = COALESCE($7, website),
        specializations  = COALESCE($8::jsonb, specializations),
        fee_percentage   = COALESCE($9, fee_percentage),
        payment_terms    = COALESCE($10, payment_terms),
        agreement_start  = COALESCE($11, agreement_start),
        agreement_end    = COALESCE($12, agreement_end),
        is_active        = COALESCE($13, is_active),
        notes            = COALESCE($14, notes),
        city             = COALESCE($15, city),
        updated_at       = NOW()
      WHERE id = $1
        AND ($2::int IS NULL OR company_id = $2)
      RETURNING *
    `, [
      req.params.id,
      companyId,
      name || null,
      contact_person || null,
      email ?? null,
      phone ?? null,
      website ?? null,
      specializations ? JSON.stringify(specializations) : null,
      fee_percentage != null && fee_percentage !== '' ? parseFloat(fee_percentage) : null,
      payment_terms ?? null,
      agreement_start ?? null,
      agreement_end ?? null,
      is_active === undefined ? null : is_active !== false,
      notes ?? null,
      city ?? null,
    ]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Agency not found' });
    res.json({ data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/talent/agencies/:id
router.delete('/agencies/:id', remove, captureBefore('recruitment_agencies'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const check = await pool.query(
      `SELECT COUNT(*) AS cnt FROM candidates WHERE source_agency_id = $1`,
      [req.params.id]
    );
    if (parseInt(check.rows[0].cnt) > 0) {
      return res.status(400).json({
        error: 'Agency has sourced candidates — deactivate instead of deleting',
      });
    }
    await pool.query(
      `DELETE FROM recruitment_agencies WHERE id = $1
       AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/talent/agencies/:id/candidates
router.get('/agencies/:id/candidates', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const r = await pool.query(`
      SELECT c.id, c.full_name,
             c.email, c.phone, c.current_designation, c.current_stage AS stage, c.current_company,
             c.experience_years, c.created_at,
             jo.job_title AS applied_position
      FROM candidates c
      LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
      WHERE c.source_agency_id = $1 AND c.deleted_at IS NULL
        AND ($2::int IS NULL OR c.company_id = $2)
      ORDER BY c.created_at DESC
    `, [req.params.id, companyId]);
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEW QUESTIONS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/talent/questions/stats  (must be before /questions/:id)
router.get('/questions/stats', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    await seedBankOnFirstUse(companyId);
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active = true)::int AS total,
        COUNT(*) FILTER (WHERE category = 'Technical'    AND is_active = true)::int AS technical,
        COUNT(*) FILTER (WHERE category = 'HR'           AND is_active = true)::int AS hr,
        COUNT(*) FILTER (WHERE category = 'Behavioural'  AND is_active = true)::int AS behavioural,
        COUNT(*) FILTER (WHERE category = 'Situational'  AND is_active = true)::int AS situational,
        COUNT(*) FILTER (WHERE category = 'Cultural Fit' AND is_active = true)::int AS cultural_fit,
        COUNT(*) FILTER (WHERE category = 'Domain'       AND is_active = true)::int AS domain,
        COUNT(*) FILTER (WHERE difficulty = 'easy'   AND is_active = true)::int AS easy,
        COUNT(*) FILTER (WHERE difficulty = 'medium' AND is_active = true)::int AS medium,
        COUNT(*) FILTER (WHERE difficulty = 'hard'   AND is_active = true)::int AS hard
      FROM interview_questions
      WHERE ($1::int IS NULL OR company_id = $1)
    `, [companyId]);
    const row = r.rows[0];
    res.json({
      data: {
        total: row.total,
        by_category: {
          Technical:    row.technical,
          HR:           row.hr,
          Behavioural:  row.behavioural,
          Situational:  row.situational,
          'Cultural Fit': row.cultural_fit,
          Domain:       row.domain,
        },
        by_difficulty: { easy: row.easy, medium: row.medium, hard: row.hard },
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared by /questions and the legacy /interview-questions alias below — the
// legacy route used to run its own SQL with no company_id filter at all (any
// authenticated user could read every company's question bank) and wrote to
// the old `tags` text column instead of `tags_jsonb`, orphaning rows that the
// scoped /questions endpoint could never see. One query, two response shapes.
async function listQuestions(companyId, { category = '', difficulty = '', job_role = '', search = '' } = {}) {
  await seedBankOnFirstUse(companyId);
  const r = await pool.query(`
    SELECT id, question, category, difficulty, job_role,
           expected_answer, tags_jsonb AS tags, is_active, created_at
    FROM interview_questions
    WHERE ($1::int IS NULL OR company_id = $1)
      AND COALESCE(is_active, true) = true
      AND ($2 = '' OR category = $2)
      AND ($3 = '' OR difficulty = $3)
      AND ($4 = '' OR job_role ILIKE '%' || $4 || '%')
      AND ($5 = '' OR question  ILIKE '%' || $5 || '%')
    ORDER BY category, difficulty, created_at DESC
  `, [companyId, category, difficulty, job_role, search]);
  return r.rows;
}

async function insertQuestion(companyId, { question, category, difficulty, job_role, expected_answer, tags }) {
  const r = await pool.query(`
    INSERT INTO interview_questions
      (company_id, question, category, difficulty, job_role, expected_answer, tags_jsonb, is_active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true)
    RETURNING id, question, category, difficulty, job_role,
              expected_answer, tags_jsonb AS tags, is_active, created_at
  `, [
    companyId, question, category || 'General',
    difficulty || 'medium',
    job_role || null,
    expected_answer || null,
    tags ? JSON.stringify(tags) : '[]',
  ]);
  return r.rows[0];
}

// GET /api/talent/questions
router.get('/questions', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const rows = await listQuestions(companyId, req.query);
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/talent/questions
router.post('/questions', add, async (req, res) => {
  try {
    const { question, category } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (!category) return res.status(400).json({ error: 'category is required' });
    const companyId = getCid(req);
    const row = await insertQuestion(companyId, req.body);
    res.status(201).json({ data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/talent/questions/:id
router.put('/questions/:id', edit, captureBefore('interview_questions'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const { question, category, difficulty, job_role, expected_answer, tags } = req.body;
    const r = await pool.query(`
      UPDATE interview_questions SET
        question        = COALESCE($3, question),
        category        = COALESCE($4, category),
        difficulty      = COALESCE($5, difficulty),
        job_role        = $6,
        expected_answer = $7,
        tags_jsonb      = COALESCE($8::jsonb, tags_jsonb)
      WHERE id = $1
        AND ($2::int IS NULL OR company_id = $2)
      RETURNING id, question, category, difficulty, job_role,
                expected_answer, tags_jsonb AS tags, is_active, created_at
    `, [
      req.params.id, companyId,
      question || null, category || null, difficulty || null,
      job_role ?? null, expected_answer ?? null,
      tags ? JSON.stringify(tags) : null,
    ]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Question not found' });
    res.json({ data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/talent/questions/:id  (soft delete)
router.delete('/questions/:id', remove, captureBefore('interview_questions'), async (req, res) => {
  try {
    const companyId = getCid(req);
    await pool.query(
      `UPDATE interview_questions SET is_active = false
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TALENT BANK CATEGORIES (table talent_pools)
//
// 2026-11-17 merge: the "Talent Pools" page and the Talent Bank's categories were
// the same table on two screens. Categories are now managed only from the Talent
// Bank page (Manage categories). People are added through
// POST /recruitment/candidates/:id/talent-bank and removed through
// DELETE /recruitment/candidates/:id/talent-bank — those also set the candidate's
// status, stage and history. The old /pools/:id/members routes wrote a bare
// membership row with none of that, so they were removed.
// ─────────────────────────────────────────────────────────────────────────────

// The groups the Talent Bank page draws its chips under.
export const POOL_CATEGORIES = ['engineering', 'product', 'operations', 'commercial', 'corporate', 'pipeline', 'other'];
const cleanCategory = (v) => {
  if (v === undefined) return undefined;
  const s = String(v || '').trim().toLowerCase();
  return POOL_CATEGORIES.includes(s) ? s : 'other';
};

const POOL_SELECT = `
  SELECT
    tp.id, tp.pool_name, tp.description,
    COALESCE(tp.skills, '[]'::jsonb) AS skills,
    tp.skill_focus, tp.department, COALESCE(tp.category, 'other') AS category,
    COALESCE(tp.is_seeded, false) AS is_seeded,
    COALESCE(tp.is_active, true) AS is_active,
    tp.source, tp.created_at, tp.updated_at,
    -- Only live candidates: a deleted candidate's membership row must not keep a
    -- category looking used (or block its deletion).
    (SELECT COUNT(DISTINCT m.candidate_id)::int
       FROM talent_pool_members m JOIN candidates c ON c.id = m.candidate_id AND c.deleted_at IS NULL
      WHERE m.pool_id = tp.id) AS member_count,
    e.name AS created_by_name
  FROM talent_pools tp
  LEFT JOIN employees e ON e.id = tp.created_by`;

// GET /api/talent/pools — every category, including switched-off ones (the
// manage dialog needs those to switch them back on).
router.get('/pools', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const { search = '' } = req.query;
    const r = await pool.query(`${POOL_SELECT}
      WHERE tp.company_id = $1
        AND ($2 = '' OR tp.pool_name ILIKE '%' || $2 || '%')
      ORDER BY COALESCE(tp.category, 'other'), tp.pool_name`, [companyId, search]);
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/talent/pools/:id
router.get('/pools/:id', view, async (req, res) => {
  try {
    const r = await pool.query(`${POOL_SELECT} WHERE tp.id = $1 AND tp.company_id = $2`,
      [req.params.id, getCid(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function nameTaken(companyId, name, exceptId = null) {
  const r = await pool.query(
    `SELECT 1 FROM talent_pools WHERE company_id = $1 AND LOWER(pool_name) = LOWER($2)
        AND ($3::int IS NULL OR id <> $3)`,
    [companyId, name, exceptId]
  );
  return r.rows.length > 0;
}

// POST /api/talent/pools
router.post('/pools', add, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(403).json({ error: 'Company scope required' });
    const { description, skills, skill_focus, department, is_active, source } = req.body;
    const pool_name = String(req.body.pool_name || '').trim();
    if (!pool_name) return res.status(400).json({ error: 'Category name is required', errors: { pool_name: 'Required' } });
    if (await nameTaken(companyId, pool_name)) {
      return res.status(409).json({ error: `A category called "${pool_name}" already exists.`, errors: { pool_name: 'Already exists' } });
    }
    const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : (skills || '[]');
    const r = await pool.query(`
      INSERT INTO talent_pools
        (pool_name, description, skills, skill_focus, department, category, is_active, is_seeded, source, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10)
      RETURNING *
    `, [
      pool_name,
      description || null,
      skillsJson,
      skill_focus || null,
      department || null,
      cleanCategory(req.body.category) || 'other',
      is_active !== false,
      source || null,
      companyId,
      // talent_pools.created_by is a FOREIGN KEY to employees(id) — never users.id.
      req.user?.employee_id ?? null,
    ]);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: r.rows[0].id,
      recordType: 'talent_pool', action: 'create', newData: { pool_name, category: r.rows[0].category }, req });
    res.status(201).json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/talent/pools/:id
router.put('/pools/:id', edit, captureBefore('talent_pools'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const { description, skills, department, is_active } = req.body;
    const pool_name = req.body.pool_name !== undefined ? String(req.body.pool_name || '').trim() : undefined;
    if (pool_name === '') return res.status(400).json({ error: 'Category name is required', errors: { pool_name: 'Required' } });
    if (pool_name && await nameTaken(companyId, pool_name, parseInt(req.params.id, 10))) {
      return res.status(409).json({ error: `A category called "${pool_name}" already exists.`, errors: { pool_name: 'Already exists' } });
    }
    const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : (skills ?? null);
    const r = await pool.query(`
      UPDATE talent_pools SET
        pool_name   = COALESCE($1, pool_name),
        description = COALESCE($2, description),
        skills      = COALESCE($3::jsonb, skills),
        department  = CASE WHEN $4::boolean THEN $5 ELSE department END,
        is_active   = COALESCE($6, is_active),
        category    = COALESCE($7, category),
        updated_at  = NOW()
      WHERE id = $8 AND company_id = $9
      RETURNING *
    `, [
      pool_name || null,
      description !== undefined ? (description || '') : null,
      skillsJson,
      department !== undefined, department || null,
      is_active !== undefined ? Boolean(is_active) : null,
      cleanCategory(req.body.category) ?? null,
      req.params.id,
      companyId,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/talent/pools/:id
//
// A standard category (is_seeded) is switched off rather than deleted: the
// Talent Bank re-creates any standard category that is missing, so a hard delete
// silently came back the next time anyone opened the page (5 did on 2026-11-17).
router.delete('/pools/:id', remove, captureBefore('talent_pools'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const { rows: found } = await pool.query(`${POOL_SELECT} WHERE tp.id = $1 AND tp.company_id = $2`,
      [req.params.id, companyId]);
    if (!found.length) return res.status(404).json({ error: 'Category not found' });
    const p = found[0];
    if (p.member_count > 0) {
      return res.status(409).json({
        error: `${p.member_count} candidate${p.member_count === 1 ? ' is' : 's are'} kept under "${p.pool_name}". Remove them from it first, or switch the category off instead.`,
      });
    }
    if (p.is_seeded) {
      await pool.query(`UPDATE talent_pools SET is_active = false, updated_at = NOW() WHERE id = $1`, [p.id]);
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: p.id,
        recordType: 'talent_pool', action: 'deactivate', oldData: { pool_name: p.pool_name }, req });
      return res.json({ success: true, deactivated: true, message: `"${p.pool_name}" is a standard category, so it was switched off rather than deleted.` });
    }
    // Membership rows of deleted candidates would block the FK delete.
    await pool.query(`DELETE FROM talent_pool_members WHERE pool_id = $1`, [p.id]);
    await pool.query('DELETE FROM talent_pools WHERE id = $1 AND company_id = $2', [p.id, companyId]);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: p.id,
      recordType: 'talent_pool', action: 'delete', oldData: { pool_name: p.pool_name }, req });
    res.json({ success: true, message: `"${p.pool_name}" deleted.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Removed 2026-11-17 (recruitment page audit, duplications D1/D5):
//  · GET /recruiter-dashboard — backed the Pipeline Snapshot page, a third copy
//    of My Work + the Recruitment Dashboard.
//  · /resumes, /resumes/stats, /resumes/skills, PUT /resumes/:id — the Résumé
//    Database tab, a second candidate list with its own add/edit. Candidates are
//    added and edited through /recruitment/candidates.
//  · /interview-questions — legacy alias of /questions with no caller.

export default router;
