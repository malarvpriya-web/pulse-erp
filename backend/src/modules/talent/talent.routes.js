import { Router } from 'express';
import multer from 'multer';
import pool from '../shared/db.js';
import { companyOf } from '../../shared/scope.js';
import recruitmentRepository from '../recruitment/repositories/recruitment.repository.js';
import { getOfferValidityDays } from '../recruitment/offerValidity.js';
import {
  ensureFolder,
  uploadFile as driveUpload,
  moveFile,
  isDriveConfigured,
} from '../../services/googleDrive.service.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { uploadFile as storeFile } from '../../services/StorageService.js';
// Authorization. This router previously carried NONE — server.js mounts it with
// verifyToken only, so all 26 routes below (the whole résumé/candidate database,
// talent pools, agency commercial terms, the question bank) were readable AND
// writable by any authenticated user of any role, including roles whose
// role_permissions row sets recruitment can_view = false. Its sibling
// recruitment.routes.js has always gated every route, which is precisely what
// made this easy to miss. Same module key ('recruitment') and same four actions,
// so the existing matrix already covers every role that reaches these pages.
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { ensureDefaultInterviewQuestions } from './defaultInterviewQuestions.js';

const router = Router();

const view   = requirePermission('recruitment', 'view');
const add    = requirePermission('recruitment', 'add');
const edit   = requirePermission('recruitment', 'edit');
const remove = requirePermission('recruitment', 'delete');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only PDF/Word allowed'), { status: 415 }));
  },
});

let _unsolicitedFolderId = null;
async function getUnsolicitedFolder() {
  if (_unsolicitedFolderId) return _unsolicitedFolderId;
  if (!isDriveConfigured()) return null;
  const root = await ensureFolder('Recruitment', null);
  _unsolicitedFolderId = await ensureFolder('Unsolicited Resumes', root);
  return _unsolicitedFolderId;
}

// ── Schema migration ──────────────────────────────────────────────────────────
// Exported so a test can wait for the import-time DDL to finish (it used to be a
// bare IIFE nothing could observe). Each step catches its own error, so this
// promise always resolves.
export const talentSchemaReady = (async () => {
  // Each step is isolated so one failure doesn't skip later steps.
  const run = async (label, fn) => {
    try { await fn(); }
    catch (e) { console.error(`[talent] migration step "${label}" failed:`, e.message); }
  };

  // ── Core tables ─────────────────────────────────────────────────────────────
  await run('talent_pools', () => pool.query(`
    CREATE TABLE IF NOT EXISTS talent_pools (
      id           SERIAL PRIMARY KEY,
      pool_name    VARCHAR(200) NOT NULL,
      description  TEXT,
      skill_focus  VARCHAR(200),
      source       VARCHAR(100),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // talent_pool_candidates is deliberately NOT created here any more. It was a
  // second table recording the same relationship as talent_pool_members — the
  // one every endpoint in this file actually reads — so memberships landed in
  // one table and were read from the other, and every pool reported zero
  // members. Migration 20260917000030 merged the two and dropped it; recreating
  // it on boot would resurrect the split. See that migration for the full story.

  await run('recruitment_agencies', () => pool.query(`
    CREATE TABLE IF NOT EXISTS recruitment_agencies (
      id              SERIAL PRIMARY KEY,
      agency_name     VARCHAR(200) NOT NULL,
      contact_name    VARCHAR(200),
      email           VARCHAR(200),
      phone           VARCHAR(50),
      specialization  VARCHAR(200),
      commission_pct  NUMERIC(5,2) DEFAULT 0,
      city            VARCHAR(100),
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  await run('interview_questions', () => pool.query(`
    CREATE TABLE IF NOT EXISTS interview_questions (
      id               SERIAL PRIMARY KEY,
      question         TEXT NOT NULL,
      category         VARCHAR(100) DEFAULT 'General',
      difficulty       VARCHAR(50)  DEFAULT 'Medium',
      expected_answer  TEXT,
      tags             TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // ── Extend recruitment_agencies ───────────────────────────────────────────
  await run('extend recruitment_agencies', () => pool.query(`
    ALTER TABLE recruitment_agencies
      ADD COLUMN IF NOT EXISTS company_id      INTEGER REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS contact_person  VARCHAR(255),
      ADD COLUMN IF NOT EXISTS website         VARCHAR(255),
      ADD COLUMN IF NOT EXISTS fee_percentage  NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS specializations JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS payment_terms   TEXT,
      ADD COLUMN IF NOT EXISTS agreement_start DATE,
      ADD COLUMN IF NOT EXISTS agreement_end   DATE,
      ADD COLUMN IF NOT EXISTS is_active       BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW()
  `));

  // ── Extend interview_questions ────────────────────────────────────────────
  await run('extend interview_questions', () => pool.query(`
    ALTER TABLE interview_questions
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS job_role   VARCHAR(255),
      ADD COLUMN IF NOT EXISTS is_active  BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS tags_jsonb JSONB DEFAULT '[]'
  `));

  // ── talent_pool_members (candidate_id INTEGER matches candidates.id SERIAL) ─
  await run('talent_pool_members', () => pool.query(`
    CREATE TABLE IF NOT EXISTS talent_pool_members (
      pool_id      INTEGER     NOT NULL,
      candidate_id INTEGER     NOT NULL,
      added_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY  (pool_id, candidate_id)
    )
  `));
  await run('talent_pool_members indexes', () => pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tpm_pool      ON talent_pool_members(pool_id);
    CREATE INDEX IF NOT EXISTS idx_tpm_candidate ON talent_pool_members(candidate_id)
  `));

  await run('extend talent_pool_members', () => pool.query(`
    ALTER TABLE talent_pool_members ADD COLUMN IF NOT EXISTS notes    TEXT;
    ALTER TABLE talent_pool_members ADD COLUMN IF NOT EXISTS added_by INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `));

  // ── talent_pools enrichment ───────────────────────────────────────────────
  await run('extend talent_pools', () => pool.query(`
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS company_id  INTEGER  REFERENCES companies(id) ON DELETE CASCADE;
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS skills       JSONB    DEFAULT '[]';
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS department   VARCHAR(100);
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS is_active    BOOLEAN  DEFAULT true;
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS created_by   INTEGER  REFERENCES employees(id) ON DELETE SET NULL;
    ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW()
  `));

  // ── Candidates agency link ────────────────────────────────────────────────
  await run('candidates source_agency_id', () => pool.query(`
    ALTER TABLE candidates
      ADD COLUMN IF NOT EXISTS source_agency_id INTEGER
        REFERENCES recruitment_agencies(id) ON DELETE SET NULL
  `));

  // Default interview questions are NOT seeded here any more. This block runs on
  // every import of the module — each server boot and each nodemon restart —
  // and seeded every active company that happened to exist at that moment,
  // integration-test companies included. They are now seeded per company on
  // first read of its bank: see defaultInterviewQuestions.js.
})();

/** Seed the company's default bank on first read; a seeding failure never blocks the read. */
async function seedBankOnFirstUse(companyId) {
  try { await ensureDefaultInterviewQuestions(companyId); }
  catch (e) { console.error('[talent] default interview-question seed failed:', e.message); }
}

// ── Helper ────────────────────────────────────────────────────────────────────
const getCid = (req) => req.scope?.company_id ?? companyOf(req);

async function verifyPoolOwnership(poolId, companyId) {
  if (!companyId) return true;
  const r = await pool.query(
    'SELECT id FROM talent_pools WHERE id=$1 AND company_id=$2',
    [poolId, companyId]
  );
  return r.rows.length > 0;
}

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
        COALESCE(a.contact_person, a.contact_name) AS contact_person,
        a.email, a.phone, a.website,
        COALESCE(a.specializations, '[]'::jsonb) AS specializations,
        a.specialization AS specialization_text,
        COALESCE(a.fee_percentage, a.commission_pct) AS fee_percentage,
        a.payment_terms,
        a.agreement_start, a.agreement_end,
        COALESCE(a.is_active, true) AS is_active,
        a.notes, a.city, a.created_at,
        COUNT(DISTINCT c.id)::int AS total_candidates,
        COUNT(DISTINCT CASE WHEN c.stage = 'hired' THEN c.id END)::int AS hired_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN c.stage = 'hired' THEN c.id END) * 100.0 /
          NULLIF(COUNT(DISTINCT c.id), 0), 1
        ) AS success_rate
      FROM recruitment_agencies a
      LEFT JOIN candidates c ON c.source_agency_id = a.id
        AND ($1::int IS NULL OR c.company_id = $1)
      WHERE ($1::int IS NULL OR a.company_id = $1)
        AND ($2 = '' OR a.agency_name ILIKE '%' || $2 || '%'
             OR a.contact_person ILIKE '%' || $2 || '%'
             OR a.contact_name   ILIKE '%' || $2 || '%')
      GROUP BY a.id
      ORDER BY hired_count DESC NULLS LAST, a.agency_name
    `, [companyId, search]);
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
             c.candidate_role, c.stage, c.current_company, c.experience_years,
             c.created_at,
             jo.job_title AS applied_position
      FROM candidates c
      LEFT JOIN job_openings jo ON jo.id = c.opening_id
      WHERE c.source_agency_id = $1
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
// TALENT POOLS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/talent/pools
router.get('/pools', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const { search = '' } = req.query;
    const r = await pool.query(`
      SELECT
        tp.id, tp.pool_name, tp.description,
        COALESCE(tp.skills, '[]'::jsonb) AS skills,
        tp.skill_focus, tp.department,
        COALESCE(tp.is_active, true) AS is_active,
        tp.source, tp.created_at, tp.updated_at,
        COUNT(DISTINCT tpm.candidate_id)::INT AS member_count,
        e.name AS created_by_name
      FROM talent_pools tp
      LEFT JOIN talent_pool_members tpm ON tpm.pool_id = tp.id
      LEFT JOIN employees e ON e.id = tp.created_by
      WHERE tp.company_id = $1
        AND ($2 = '' OR tp.pool_name ILIKE '%' || $2 || '%')
      GROUP BY tp.id, e.name
      ORDER BY tp.created_at DESC
    `, [companyId, search]);
    res.json({ data: r.rows });
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json({ data: [] });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/talent/pools/:id
router.get('/pools/:id', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const r = await pool.query(`
      SELECT
        tp.id, tp.pool_name, tp.description,
        COALESCE(tp.skills, '[]'::jsonb) AS skills,
        tp.skill_focus, tp.department,
        COALESCE(tp.is_active, true) AS is_active,
        tp.source, tp.created_at, tp.updated_at,
        COUNT(DISTINCT tpm.candidate_id)::INT AS member_count,
        e.name AS created_by_name
      FROM talent_pools tp
      LEFT JOIN talent_pool_members tpm ON tpm.pool_id = tp.id
      LEFT JOIN employees e ON e.id = tp.created_by
      WHERE tp.id = $1 AND tp.company_id = $2
      GROUP BY tp.id, e.name
    `, [req.params.id, companyId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pool not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/talent/pools
router.post('/pools', add, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(403).json({ error: 'Company scope required' });
    const { pool_name, description, skills, skill_focus, department, is_active, source } = req.body;
    if (!pool_name) return res.status(400).json({ error: 'pool_name is required' });
    const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : (skills || '[]');
    const r = await pool.query(`
      INSERT INTO talent_pools
        (pool_name, description, skills, skill_focus, department, is_active, source, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      pool_name,
      description || null,
      skillsJson,
      skill_focus || null,
      department || null,
      is_active !== false,
      source || null,
      companyId,
      // talent_pools.created_by is a FOREIGN KEY to employees(id). This used to
      // pass req.user.userId — a users.id — so every POST died on
      // talent_pools_created_by_fkey. Not "sometimes": of the 134 active users on
      // this database, ZERO have a users.id that matches any employees.id, so no
      // account in the system could create a talent pool. The nastier half is
      // what happens when the two id spaces DO overlap: the insert succeeds and
      // silently credits the pool to an unrelated employee. employee_id is the
      // claim that actually belongs in an employees column, and NULL (the column
      // is ON DELETE SET NULL) is the right answer for an admin who has no
      // employee record, rather than a wrong attribution.
      req.user?.employee_id ?? null,
    ]);
    res.status(201).json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/talent/pools/:id
router.put('/pools/:id', edit, captureBefore('talent_pools'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const { pool_name, description, skills, department, is_active } = req.body;
    const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : (skills ?? null);
    const r = await pool.query(`
      UPDATE talent_pools SET
        pool_name   = COALESCE($1, pool_name),
        description = $2,
        skills      = COALESCE($3::jsonb, skills),
        department  = $4,
        is_active   = COALESCE($5, is_active),
        updated_at  = NOW()
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `, [
      pool_name || null,
      description ?? null,
      skillsJson,
      department ?? null,
      is_active !== undefined ? is_active : null,
      req.params.id,
      companyId,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pool not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/talent/pools/:id
router.delete('/pools/:id', remove, captureBefore('talent_pools'), async (req, res) => {
  try {
    const companyId = getCid(req);
    const members = await pool.query(
      'SELECT COUNT(*) AS cnt FROM talent_pool_members WHERE pool_id = $1',
      [req.params.id]
    );
    if (parseInt(members.rows[0].cnt) > 0) {
      return res.status(400).json({ error: 'Remove all members before deleting this pool' });
    }
    const r = await pool.query(
      'DELETE FROM talent_pools WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, companyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pool not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/talent/pools/:id/members
router.get('/pools/:id/members', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!(await verifyPoolOwnership(req.params.id, companyId)))
      return res.status(403).json({ error: 'Access denied' });
    const r = await pool.query(`
      SELECT
        c.id,
        COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS name,
        c.email, c.phone,
        COALESCE(c.current_stage, c.stage) AS stage,
        c.experience_years,
        c.current_company,
        COALESCE(c.current_designation, c.candidate_role) AS current_designation,
        COALESCE(c.resume_gdrive_url, c.resume_url) AS resume_url,
        COALESCE(c.skills, '[]'::jsonb) AS skills,
        tpm.notes, tpm.added_at,
        e.name AS added_by_name
      FROM talent_pool_members tpm
      JOIN candidates c ON c.id = tpm.candidate_id
      LEFT JOIN employees e ON e.id = tpm.added_by
      WHERE tpm.pool_id = $1
      ORDER BY tpm.added_at DESC
    `, [req.params.id]);
    res.json({ data: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/talent/pools/:id/members
router.post('/pools/:id/members', add, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!(await verifyPoolOwnership(req.params.id, companyId)))
      return res.status(403).json({ error: 'Access denied' });
    const poolId = parseInt(req.params.id, 10);
    const { candidate_id, notes } = req.body;
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });
    // Guard the candidate the same way verifyPoolOwnership() guards the pool —
    // without it, a caller could add another company's candidate to their own
    // pool by id and then read that candidate's full profile back through
    // GET /pools/:id/members.
    const owns = await pool.query(
      `SELECT 1 FROM candidates WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [candidate_id, companyId]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'Candidate not found' });

    await pool.query(
      // added_by is a FOREIGN KEY to employees(id) — see the note on
      // talent_pools.created_by above. This passed users.id and 500'd on
      // talent_pool_members_added_by_fkey for every caller.
      `INSERT INTO talent_pool_members (pool_id, candidate_id, added_by, notes)
       VALUES ($1,$2,$3,$4) ON CONFLICT (pool_id, candidate_id) DO NOTHING`,
      [poolId, candidate_id, req.user?.employee_id ?? null, notes || null]
    );
    const r = await pool.query(`
      SELECT
        c.id,
        COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS name,
        c.email, c.phone,
        COALESCE(c.current_stage, c.stage) AS stage,
        c.experience_years, c.current_company,
        COALESCE(c.current_designation, c.candidate_role) AS current_designation,
        COALESCE(c.resume_gdrive_url, c.resume_url) AS resume_url,
        COALESCE(c.skills, '[]'::jsonb) AS skills,
        tpm.notes, tpm.added_at,
        e.name AS added_by_name
      FROM talent_pool_members tpm
      JOIN candidates c ON c.id = tpm.candidate_id
      LEFT JOIN employees e ON e.id = tpm.added_by
      WHERE tpm.pool_id = $1 AND tpm.candidate_id = $2
    `, [poolId, candidate_id]);
    res.status(201).json({ data: r.rows[0] || { candidate_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/talent/pools/:id/members/:candidateId
router.delete('/pools/:id/members/:candidateId', remove, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!(await verifyPoolOwnership(req.params.id, companyId)))
      return res.status(403).json({ error: 'Access denied' });
    await pool.query(
      `DELETE FROM talent_pool_members WHERE pool_id=$1 AND candidate_id=$2`,
      [parseInt(req.params.id, 10), parseInt(req.params.candidateId, 10)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RECRUITER DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

router.get('/recruiter-dashboard', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    const cFilter   = companyId ? ' AND company_id=$1' : '';
    const params    = companyId ? [companyId] : [];

    // ── Core KPI counts ────────────────────────────────────────────────────
    // Delegated to recruitmentRepository.getRecruitmentKpis() — the canonical
    // source shared with /recruitment/dashboard-summary. These were four
    // independent queries here, two of which (open_positions, pending_offers)
    // omitted `deleted_at IS NULL` and so disagreed with the exec Dashboard's
    // same-named KPIs whenever a row had been soft-deleted.
    const kpis = await recruitmentRepository.getRecruitmentKpis(companyId);

    // ── Candidate pipeline by stage ────────────────────────────────────────
    // Shared with /recruitment/pipeline-summary and /recruitment/pipeline/:id
    // via recruitmentRepository.getPipelineSummary() — was its own third copy
    // of this SQL.
    let pipeline = [];
    try {
      pipeline = await recruitmentRepository.getPipelineSummary(companyId);
    } catch (_) { /* non-fatal */ }

    // ── Today's interviews ─────────────────────────────────────────────────
    // Previously selected no candidate/job columns at all and hardcoded
    // candidate_name to the literal string 'See candidate pipeline' and
    // job_title to null on every row — every dashboard load showed that
    // placeholder instead of who the interview was actually with. Fixed
    // 2026-08-12 by actually joining candidates/job_openings, same pattern
    // recruitment.repository.js's findInterviews() already uses.
    let today_interviews = [];
    try {
      const ti = await pool.query(
        `SELECT iv.id, iv.candidate_id, iv.interview_time, iv.interview_mode, iv.meeting_link,
                e.name AS interviewer_name,
                COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS candidate_name,
                jo.job_title
         FROM interview_schedules iv
         LEFT JOIN employees e ON e.id = iv.interviewer_id
         LEFT JOIN candidates c ON c.id = iv.candidate_id
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
         WHERE iv.interview_date = CURRENT_DATE
           AND iv.status != 'cancelled'
           ${companyId ? 'AND iv.company_id=$1' : ''}
         ORDER BY iv.interview_time`,
        params
      );
      today_interviews = ti.rows;
    } catch (_) { /* interview_schedules schema may differ */ }

    // ── Recent applications (last 7 days) ─────────────────────────────────
    let recent_applications = [];
    try {
      const ra = await pool.query(
        `SELECT c.id,
                COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS name,
                jo.job_title AS applied_for,
                c.source,
                c.created_at AS applied_date
         FROM candidates c
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
         WHERE c.deleted_at IS NULL
           AND c.created_at >= NOW() - INTERVAL '7 days'
           ${companyId ? 'AND c.company_id=$1' : ''}
         ORDER BY c.created_at DESC LIMIT 10`,
        params
      );
      recent_applications = ra.rows;
    } catch (_) { /* non-fatal */ }

    // ── Expiring offers ────────────────────────────────────────────────────
    // Previously selected ol.offer_expiry_date and ol.position — neither
    // column exists on offer_letters (see its CREATE TABLE in
    // recruitment.routes.js: candidate_id, job_opening_id, offered_salary,
    // joining_date, offer_status, offer_sent_date, response_date, notes,
    // company_id — no expiry/position columns at all) — so this query threw
    // on every single call, silently swallowed by the catch below, and
    // "Expiring Offers" showed 0 unconditionally.
    //
    // Expiry is now a STORED column (offer_letters.offer_expiry_date, migration
    // 20260813000001) stamped when the offer is sent, rather than derived on every
    // read. That is what lets a recruiter extend one candidate's deadline without
    // moving everybody else's — and it stops a change to the company default from
    // retroactively rewriting the expiry of offers already sent.
    //
    // The COALESCE fallback to offer_sent_date + configured validity covers rows
    // the migration's backfill couldn't reach (any offer sent with no sent date)
    // and keeps this panel correct if a future write path forgets to stamp it.
    let expiring_offers  = [];
    let expiring_count   = 0;
    try {
      const validityDays = await getOfferValidityDays(companyId ?? null);

      const eo = await pool.query(
        `SELECT ol.id, ol.candidate_id, ol.offer_sent_date,
                COALESCE(ol.offer_expiry_date,
                         (ol.offer_sent_date + $${params.length + 1}::int)::date) AS offer_expiry_date,
                COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS candidate_name,
                jo.job_title AS position
         FROM offer_letters ol
         LEFT JOIN candidates c ON c.id = ol.candidate_id
         LEFT JOIN job_openings jo ON jo.id = ol.job_opening_id
         WHERE ol.offer_status = 'sent'
           AND ol.deleted_at IS NULL
           AND COALESCE(ol.offer_expiry_date,
                        (ol.offer_sent_date + $${params.length + 1}::int)::date)
                 BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
           ${companyId ? 'AND ol.company_id=$1' : ''}
         ORDER BY offer_expiry_date`,
        [...params, validityDays]
      );
      expiring_offers = eo.rows;
      expiring_count  = eo.rows.length;
    } catch (_) { /* offer_letters schema may differ */ }

    // ── Action items: candidates nobody has touched in 7+ days ─────────────
    //
    // Two defects fixed here 2026-09-27, both of which made this panel lie:
    //
    //  1. It measured `NOW() - c.created_at` while its own heading claimed "7+
    //     days without movement". Those are different questions: a candidate
    //     created thirty days ago and interviewed yesterday was reported as
    //     waiting thirty days. There was no column recording the last movement,
    //     which is why migration 20260927000001 added `last_activity_at` —
    //     stamped by candidateIntelligence.recordActivity() on every mutation in
    //     the module, and backfilled from candidate_stage_history for existing
    //     rows. COALESCE to created_at covers a candidate who has genuinely never
    //     moved since being created, where age IS the waiting time.
    //
    //  2. It excluded only ('hired','rejected'), so every candidate parked in
    //     not_suitable / maybe / future_use sat in the recruiter's action list
    //     forever — permanently, since nothing would ever move them again. Only
    //     LIVE stages are actionable; a Talent Bank candidate is not waiting on
    //     anybody, and 'future_use' has its own dated reminder
    //     (candidate_recontact) rather than belonging here.
    let action_items = [];
    try {
      const ai = await pool.query(
        `SELECT c.id,
                COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS name,
                c.current_stage AS stage,
                jo.job_title,
                DATE_PART('day', NOW() - COALESCE(c.last_activity_at, c.created_at))::int AS days_waiting
         FROM candidates c
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
         WHERE c.deleted_at IS NULL
           AND c.current_stage IN ('applied','screening','shortlisted','assessment',
                                   '1st_level','2nd_level','offer','selected')
           AND COALESCE(c.last_activity_at, c.created_at) < NOW() - INTERVAL '7 days'
           ${companyId ? 'AND c.company_id=$1' : ''}
         ORDER BY COALESCE(c.last_activity_at, c.created_at) ASC LIMIT 10`,
        params
      );
      action_items = ai.rows;
    } catch (_) { /* non-fatal */ }

    res.json({
      data: {
        stats: {
          open_positions:        kpis.open_positions,
          open_headcount:        kpis.open_headcount,
          total_candidates:      kpis.total_candidates,
          active_candidates:     kpis.active_candidates,
          upcoming_interviews:   kpis.upcoming_interviews,
          pending_offers:        kpis.pending_offers,
          expiring_offers_count: expiring_count,
          avg_time_to_hire:      kpis.avg_time_to_hire,
        },
        pipeline,
        today_interviews,
        recent_applications,
        expiring_offers,
        action_items,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUME DATABASE
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/talent/resumes/stats — must be declared before /resumes to avoid param collision
router.get('/resumes/stats', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });
    const r = await pool.query(
      `SELECT
         COUNT(*)::INT                                                                  AS total,
         COUNT(*) FILTER (WHERE current_stage='applied')::INT                          AS applied,
         COUNT(*) FILTER (WHERE current_stage='screening')::INT                        AS screening,
         COUNT(*) FILTER (WHERE current_stage='1st_level')::INT                        AS first_level,
         COUNT(*) FILTER (WHERE current_stage='2nd_level')::INT                        AS second_level,
         COUNT(*) FILTER (WHERE current_stage='offer')::INT                            AS offer,
         COUNT(*) FILTER (WHERE current_stage='hired')::INT                            AS hired,
         COUNT(*) FILTER (WHERE current_stage='rejected')::INT                         AS rejected,
         COUNT(*) FILTER (WHERE resume_gdrive_url IS NOT NULL
                              OR (resume_file_url IS NOT NULL
                                  AND resume_file_url != ''))::INT                     AS with_resume,
         COUNT(*) FILTER (WHERE resume_gdrive_url IS NULL
                              AND (resume_file_url IS NULL
                                   OR resume_file_url = ''))::INT                      AS without_resume
       FROM candidates
       WHERE company_id=$1 AND deleted_at IS NULL`,
      [companyId]
    );
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/talent/resumes/skills — top skill chips for filter UI
router.get('/resumes/skills', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });
    const r = await pool.query(
      `SELECT skill, COUNT(*)::INT AS freq
       FROM candidates,
            jsonb_array_elements_text(COALESCE(skills, '[]'::jsonb)) AS skill
       WHERE company_id=$1 AND deleted_at IS NULL
       GROUP BY skill ORDER BY freq DESC LIMIT 30`,
      [companyId]
    );
    res.json({ data: r.rows.map(row => row.skill) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/talent/resumes
router.get('/resumes', view, async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });

    const stage  = req.query.stage  || 'all';
    const search = (req.query.search || '').trim();
    const skill  = (req.query.skill  || '').trim();

    const r = await pool.query(
      `SELECT
         c.id, c.full_name, c.email, c.phone, c.source,
         c.current_stage, c.overall_status,
         c.created_at                              AS applied_date,
         c.resume_file_url,
         c.resume_gdrive_url,
         c.resume_gdrive_file_id,
         COALESCE(c.skills,  '[]'::jsonb)          AS skills,
         c.experience_years,
         c.current_company,
         c.current_designation,
         c.notice_period_days,
         c.expected_ctc,
         COALESCE(c.tags,    '[]'::jsonb)          AS tags,
         c.notes,
         c.applied_job_id,
         jo.job_title                              AS applied_for,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', tp.id, 'name', tp.pool_name))
           FILTER (WHERE tp.id IS NOT NULL),
           '[]'::json
         ) AS talent_pools
       FROM candidates c
       LEFT JOIN job_openings jo         ON jo.id  = c.applied_job_id
       LEFT JOIN talent_pool_members tpm ON tpm.candidate_id = c.id
       LEFT JOIN talent_pools tp         ON tp.id  = tpm.pool_id
       WHERE c.company_id = $1
         AND c.deleted_at IS NULL
         AND ($2 = 'all' OR c.current_stage = $2)
         AND (
           $3 = ''
           OR c.full_name            ILIKE '%' || $3 || '%'
           OR c.email                ILIKE '%' || $3 || '%'
           OR c.current_company      ILIKE '%' || $3 || '%'
           OR c.current_designation  ILIKE '%' || $3 || '%'
           OR COALESCE(c.skills::text, '') ILIKE '%' || $3 || '%'
         )
         AND ($4 = '' OR COALESCE(c.skills::text, '') ILIKE '%' || $4 || '%')
       GROUP BY c.id, jo.job_title
       ORDER BY c.created_at DESC
       LIMIT 500`,
      [companyId, stage, search, skill]
    );
    res.json({ data: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/talent/resumes — speculative upload (no job opening required)
router.post('/resumes', add, upload.single('resume'), async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      name, email, phone,
      current_company, current_designation,
      experience_years, notice_period_days, expected_ctc, notes,
    } = req.body;

    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

    let skills = [];
    try { skills = JSON.parse(req.body.skills || '[]'); } catch { skills = []; }

    // Routed through the shared recruitmentRepository.createCandidate() —
    // previously its own separate INSERT (source: 'manual', no
    // candidate_stage_history row). 'resume_db' distinguishes speculative
    // Resume Database uploads from job-application-sourced candidates.
    // Education, location and the parsed résumé text ride along with everything
    // else. They arrive as multipart strings, so each is normalised here rather
    // than trusted — a graduation year of "" would fail the CHECK constraint.
    const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
    const candidate = await recruitmentRepository.createCandidate({
      full_name: name, email, phone: phone || null,
      current_company: current_company || null,
      current_designation: current_designation || null,
      experience_years: experience_years ? parseFloat(experience_years) : null,
      notice_period_days: intOrNull(notice_period_days),
      expected_ctc: (() => { const n = parseFloat(expected_ctc); return isNaN(n) ? null : n; })(),
      skills,
      notes: notes || null,
      location:        String(req.body.location ?? '').trim() || null,
      qualification:   String(req.body.qualification ?? '').trim() || null,
      specialisation:  String(req.body.specialisation ?? '').trim() || null,
      institution:     String(req.body.institution ?? '').trim() || null,
      graduation_year: intOrNull(req.body.graduation_year),
      resume_text:     String(req.body.resume_text ?? '').trim() || null,
      parse_source:    String(req.body.parse_source ?? '').trim() || null,
      source: 'resume_db',
      company_id: companyId,
    });

    // Storing the file used to happen ONLY inside `if (req.file &&
    // isDriveConfigured())`, with no else. Google Drive is optional and is not
    // configured on most deployments, so the ordinary outcome was: recruiter
    // attaches a résumé, endpoint returns 201, file is discarded, and nothing
    // anywhere says so. POST /recruitment/candidates has always persisted via
    // StorageService; this path now falls back to the same writer, so a résumé
    // lands somewhere retrievable regardless of how the module is configured.
    if (req.file) {
      let stored = false;
      if (isDriveConfigured()) {
        try {
          const folderId = await getUnsolicitedFolder();
          const result = await driveUpload({
            buffer: req.file.buffer, originalName: req.file.originalname,
            mimeType: req.file.mimetype || 'application/pdf', moduleType: 'hr', entityLabel: null,
          });
          if (folderId && result?.drive_file_id) await moveFile(result.drive_file_id, folderId);
          if (result?.drive_file_id) {
            await pool.query(
              `UPDATE candidates SET resume_gdrive_file_id=$1, resume_gdrive_url=$2,
               current_resume_folder='Applied' WHERE id=$3`,
              [result.drive_file_id, result.drive_link, candidate.id]
            );
            candidate.resume_gdrive_file_id = result.drive_file_id;
            candidate.resume_gdrive_url     = result.drive_link;
            stored = true;
          }
        } catch (driveErr) {
          console.warn('[talent] Drive upload failed, falling back to local storage:', driveErr.message);
        }
      }
      if (!stored) {
        const url = await storeFile(req.file.buffer, req.file.originalname, req.file.mimetype);
        await pool.query(`UPDATE candidates SET resume_file_url=$1 WHERE id=$2`, [url, candidate.id]);
        candidate.resume_file_url = url;
      }
    }

    res.status(201).json({ data: candidate });
  } catch (e) {
    // createCandidate() raises a 409 for an already-known email — surface it as
    // such rather than a 500, so the uploader is told it's a duplicate.
    res.status(e.statusCode || 500).json({ error: e.message, existing_candidate_id: e.existingCandidateId });
  }
});

// PUT /api/talent/resumes/:id — update candidate profile from Resume Database
router.put('/resumes/:id', edit, captureBefore('candidates'), async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });
    const {
      full_name, email, phone,
      current_company, current_designation,
      experience_years, notice_period_days, expected_ctc, notes,
    } = req.body;
    let skills = req.body.skills;
    if (typeof skills === 'string') {
      try { skills = JSON.parse(skills); } catch { skills = skills.split(',').map(s => s.trim()).filter(Boolean); }
    }
    // Same patch-vs-replace fix as PUT /agencies/:id above: these seven columns
    // were assigned raw, so any request that omitted one erased it. A partial
    // update from anywhere — a future caller, a script, a half-filled form —
    // silently wiped a candidate's phone, employer, designation, experience,
    // notice period, expected CTC and notes.
    const r = await pool.query(
      `UPDATE candidates SET
         full_name            = COALESCE($3, full_name),
         email                = COALESCE($4, email),
         phone                = COALESCE($5, phone),
         current_company      = COALESCE($6, current_company),
         current_designation  = COALESCE($7, current_designation),
         experience_years     = COALESCE($8, experience_years),
         notice_period_days   = COALESCE($9, notice_period_days),
         expected_ctc         = COALESCE($10, expected_ctc),
         skills               = COALESCE($11::jsonb, skills),
         location             = COALESCE($13, location),
         notes                = COALESCE($12, notes),
         updated_at           = CURRENT_TIMESTAMP
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        req.params.id,
        companyId,
        full_name          || null,
        email              || null,
        phone              ?? null,
        current_company    ?? null,
        current_designation ?? null,
        (() => { const n = parseFloat(experience_years); return isNaN(n) ? null : n; })(),
        (() => { const n = parseInt(notice_period_days, 10); return isNaN(n) ? null : n; })(),
        (() => { const n = parseFloat(expected_ctc); return isNaN(n) ? null : n; })(),
        skills             != null ? JSON.stringify(skills)        : null,
        notes              ?? null,
        req.body.location  ?? null,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy interview-questions endpoints — forward to the same query/insert
// logic as /questions above (see listQuestions/insertQuestion), just kept
// unwrapped (no {data:...} envelope) for whatever legacy caller still hits
// this path. Flagged for removal in Phase 3 once nothing depends on it.
router.get('/interview-questions', view, async (req, res) => {
  try {
    const rows = await listQuestions(getCid(req), req.query);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/interview-questions', add, async (req, res) => {
  try {
    const { question, category, difficulty, answer, tags } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    const row = await insertQuestion(getCid(req), {
      question, category, difficulty, expected_answer: answer, tags,
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
