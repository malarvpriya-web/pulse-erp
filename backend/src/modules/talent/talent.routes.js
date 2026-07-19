import { Router } from 'express';
import multer from 'multer';
import pool from '../shared/db.js';
import { companyOf } from '../../shared/scope.js';
import {
  ensureFolder,
  uploadFile as driveUpload,
  moveFile,
  isDriveConfigured,
} from '../../services/googleDrive.service.js';

const router = Router();

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
(async () => {
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

  await run('talent_pool_candidates', () => pool.query(`
    CREATE TABLE IF NOT EXISTS talent_pool_candidates (
      pool_id       INTEGER REFERENCES talent_pools(id) ON DELETE CASCADE,
      candidate_id  INTEGER REFERENCES candidates(id)   ON DELETE CASCADE,
      added_at      TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (pool_id, candidate_id)
    )
  `));

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
  // Drop and recreate if previously created with wrong UUID type
  await run('fix talent_pool_members uuid type', () => pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'talent_pool_members'
          AND column_name = 'candidate_id'
          AND data_type = 'uuid'
      ) THEN
        DROP TABLE IF EXISTS talent_pool_members CASCADE;
      END IF;
    END $$
  `));
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

  // ── Seed default questions for companies that have none ───────────────────
  await run('seed interview questions', async () => {
    const companies = await pool.query(`SELECT id FROM companies WHERE is_active = true`);
    for (const co of companies.rows) {
      const existing = await pool.query(
        `SELECT COUNT(*) AS cnt FROM interview_questions WHERE company_id = $1`,
        [co.id]
      );
      if (parseInt(existing.rows[0].cnt) === 0) {
        await pool.query(`
          INSERT INTO interview_questions
            (company_id, question, category, difficulty, is_active)
          VALUES
            ($1, 'Tell me about yourself and your career journey.',              'HR',          'easy',   true),
            ($1, 'Why do you want to join our company?',                        'HR',          'easy',   true),
            ($1, 'Describe a challenging project you worked on.',               'Behavioural', 'medium', true),
            ($1, 'How do you handle conflicting priorities?',                   'Situational', 'medium', true),
            ($1, 'Where do you see yourself in 5 years?',                      'HR',          'easy',   true),
            ($1, 'What is your current notice period and expected CTC?',        'HR',          'easy',   true),
            ($1, 'Explain a time you disagreed with your manager.',             'Behavioural', 'hard',   true),
            ($1, 'How do you keep your skills updated?',                        'Cultural Fit','easy',   true),
            ($1, 'Describe your ideal work environment.',                       'Cultural Fit','medium', true),
            ($1, 'What motivates you in your work?',                            'HR',          'easy',   true)
        `, [co.id]);
      }
    }
  });
})();

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
router.get('/agencies', async (req, res) => {
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
router.post('/agencies', async (req, res) => {
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
router.put('/agencies/:id', async (req, res) => {
  try {
    const companyId = getCid(req);
    const {
      name, contact_person, email, phone, website,
      specializations, fee_percentage, payment_terms,
      agreement_start, agreement_end, is_active, notes, city,
    } = req.body;
    const r = await pool.query(`
      UPDATE recruitment_agencies SET
        agency_name      = COALESCE($3, agency_name),
        contact_person   = COALESCE($4, contact_person),
        email            = $5,
        phone            = $6,
        website          = $7,
        specializations  = COALESCE($8::jsonb, specializations),
        fee_percentage   = $9,
        payment_terms    = $10,
        agreement_start  = $11,
        agreement_end    = $12,
        is_active        = $13,
        notes            = $14,
        city             = $15,
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
      fee_percentage != null ? parseFloat(fee_percentage) : null,
      payment_terms ?? null,
      agreement_start ?? null,
      agreement_end ?? null,
      is_active !== false,
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
router.delete('/agencies/:id', async (req, res) => {
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
router.get('/agencies/:id/candidates', async (req, res) => {
  try {
    const companyId = getCid(req);
    const r = await pool.query(`
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
             c.candidate_role, c.stage, c.current_company, c.experience_years,
             c.created_at,
             jo.title AS applied_position
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
router.get('/questions/stats', async (req, res) => {
  try {
    const companyId = getCid(req);
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

// GET /api/talent/questions
router.get('/questions', async (req, res) => {
  try {
    const { category = '', difficulty = '', job_role = '', search = '' } = req.query;
    const companyId = getCid(req);
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
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/talent/questions
router.post('/questions', async (req, res) => {
  try {
    const { question, category, difficulty, job_role, expected_answer, tags } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (!category) return res.status(400).json({ error: 'category is required' });
    const companyId = getCid(req);
    const r = await pool.query(`
      INSERT INTO interview_questions
        (company_id, question, category, difficulty, job_role, expected_answer, tags_jsonb, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true)
      RETURNING id, question, category, difficulty, job_role,
                expected_answer, tags_jsonb AS tags, is_active, created_at
    `, [
      companyId, question, category,
      difficulty || 'medium',
      job_role || null,
      expected_answer || null,
      tags ? JSON.stringify(tags) : '[]',
    ]);
    res.status(201).json({ data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/talent/questions/:id
router.put('/questions/:id', async (req, res) => {
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
router.delete('/questions/:id', async (req, res) => {
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
router.get('/pools', async (req, res) => {
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
router.get('/pools/:id', async (req, res) => {
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
router.post('/pools', async (req, res) => {
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
      req.user?.userId ?? null,
    ]);
    res.status(201).json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/talent/pools/:id
router.put('/pools/:id', async (req, res) => {
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
router.delete('/pools/:id', async (req, res) => {
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
router.get('/pools/:id/members', async (req, res) => {
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
router.post('/pools/:id/members', async (req, res) => {
  try {
    const companyId = getCid(req);
    if (!(await verifyPoolOwnership(req.params.id, companyId)))
      return res.status(403).json({ error: 'Access denied' });
    const poolId = parseInt(req.params.id, 10);
    const { candidate_id, notes } = req.body;
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required' });
    await pool.query(
      `INSERT INTO talent_pool_members (pool_id, candidate_id, added_by, notes)
       VALUES ($1,$2,$3,$4) ON CONFLICT (pool_id, candidate_id) DO NOTHING`,
      [poolId, candidate_id, req.user?.userId ?? null, notes || null]
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
router.delete('/pools/:id/members/:candidateId', async (req, res) => {
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

router.get('/recruiter-dashboard', async (req, res) => {
  try {
    const companyId = getCid(req);
    const cFilter   = companyId ? ' AND company_id=$1' : '';
    const params    = companyId ? [companyId] : [];

    // ── Core KPI counts ────────────────────────────────────────────────────
    const [openings, candidates, interviews, offers] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM job_openings   WHERE status='open'${cFilter}`, params),
      pool.query(`SELECT COUNT(*)::int AS count FROM candidates      WHERE deleted_at IS NULL${cFilter}`, params),
      pool.query(`SELECT COUNT(*)::int AS count FROM interview_schedules
                  WHERE interview_date >= CURRENT_DATE AND status != 'cancelled'${cFilter}`, params),
      pool.query(`SELECT COUNT(*)::int AS count FROM offer_letters   WHERE offer_status='sent'${cFilter}`, params),
    ]);

    // ── Candidate pipeline by stage ────────────────────────────────────────
    let pipeline = [];
    try {
      const pr = await pool.query(
        `SELECT current_stage AS stage, COUNT(*)::int AS count
         FROM candidates
         WHERE deleted_at IS NULL${cFilter} AND current_stage IS NOT NULL
         GROUP BY current_stage ORDER BY count DESC`,
        params
      );
      pipeline = pr.rows;
    } catch (_) { /* non-fatal */ }

    // ── Today's interviews ─────────────────────────────────────────────────
    let today_interviews = [];
    try {
      const ti = await pool.query(
        `SELECT iv.id, iv.interview_time, iv.interview_mode, iv.meeting_link,
                e.name AS interviewer_name
         FROM interview_schedules iv
         LEFT JOIN employees e ON e.id = iv.interviewer_id
         WHERE iv.interview_date = CURRENT_DATE
           AND iv.status != 'cancelled'
           ${companyId ? 'AND iv.company_id=$1' : ''}
         ORDER BY iv.interview_time`,
        params
      );
      today_interviews = ti.rows.map(r => ({
        ...r,
        candidate_name: 'See candidate pipeline',
        job_title:      null,
      }));
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

    // ── Expiring offers (next 7 days) ──────────────────────────────────────
    let expiring_offers  = [];
    let expiring_count   = 0;
    try {
      const eo = await pool.query(
        `SELECT ol.id, ol.offer_expiry_date, ol.position
         FROM offer_letters ol
         WHERE ol.offer_status = 'sent'
           AND ol.offer_expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
           AND ol.deleted_at IS NULL
           ${companyId ? 'AND ol.company_id=$1' : ''}
         ORDER BY ol.offer_expiry_date`,
        params
      );
      expiring_offers = eo.rows.map(r => ({ ...r, candidate_name: '—' }));
      expiring_count  = eo.rows.length;
    } catch (_) { /* offer_letters schema may differ */ }

    // ── Action items: stale active candidates (7+ days without movement) ──
    let action_items = [];
    try {
      const ai = await pool.query(
        `SELECT c.id,
                COALESCE(c.full_name, CONCAT(c.first_name, ' ', c.last_name)) AS name,
                c.current_stage AS stage,
                jo.job_title,
                DATE_PART('day', NOW() - c.created_at)::int AS days_waiting
         FROM candidates c
         LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
         WHERE c.deleted_at IS NULL
           AND c.current_stage NOT IN ('hired', 'rejected')
           AND c.created_at < NOW() - INTERVAL '7 days'
           ${companyId ? 'AND c.company_id=$1' : ''}
         ORDER BY c.created_at ASC LIMIT 10`,
        params
      );
      action_items = ai.rows;
    } catch (_) { /* non-fatal */ }

    // ── Average time to hire ───────────────────────────────────────────────
    let avg_time_to_hire = null;
    try {
      const att = await pool.query(
        `SELECT ROUND(AVG(DATE_PART('day', hired_at - created_at)))::int AS avg_days
         FROM candidates WHERE hired_at IS NOT NULL AND deleted_at IS NULL${cFilter}`,
        params
      );
      avg_time_to_hire = att.rows[0]?.avg_days ?? null;
    } catch (_) { /* hired_at column may not exist */ }

    res.json({
      data: {
        stats: {
          open_positions:        openings.rows[0]?.count   ?? 0,
          total_candidates:      candidates.rows[0]?.count ?? 0,
          upcoming_interviews:   interviews.rows[0]?.count ?? 0,
          pending_offers:        offers.rows[0]?.count     ?? 0,
          expiring_offers_count: expiring_count,
          avg_time_to_hire,
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
router.get('/resumes/stats', async (req, res) => {
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
router.get('/resumes/skills', async (req, res) => {
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
router.get('/resumes', async (req, res) => {
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
router.post('/resumes', upload.single('resume'), async (req, res) => {
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

    const ins = await pool.query(
      `INSERT INTO candidates
         (full_name, email, phone, current_company, current_designation,
          experience_years, notice_period_days, expected_ctc, skills, notes,
          source, current_stage, overall_status, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'manual','applied','active',$11)
       RETURNING *`,
      [
        name, email, phone || null,
        current_company || null, current_designation || null,
        experience_years  ? parseFloat(experience_years)            : null,
        (() => { const n = parseInt(notice_period_days, 10); return isNaN(n) ? null : n; })(),
        (() => { const n = parseFloat(expected_ctc); return isNaN(n) ? null : n; })(),
        JSON.stringify(skills),
        notes || null,
        companyId,
      ]
    );
    const candidate = ins.rows[0];

    if (req.file && isDriveConfigured()) {
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
        }
      } catch (driveErr) {
        console.warn('[talent] Drive upload skipped:', driveErr.message);
      }
    }

    res.status(201).json({ data: candidate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/talent/resumes/:id — update candidate profile from Resume Database
router.put('/resumes/:id', async (req, res) => {
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
    const r = await pool.query(
      `UPDATE candidates SET
         full_name            = COALESCE($3, full_name),
         email                = COALESCE($4, email),
         phone                = $5,
         current_company      = $6,
         current_designation  = $7,
         experience_years     = $8,
         notice_period_days   = $9,
         expected_ctc         = $10,
         skills               = COALESCE($11::jsonb, skills),
         notes                = $12
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
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy interview-questions endpoints (kept for backward compat)
router.get('/interview-questions', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM interview_questions
       WHERE COALESCE(is_active, true) = true ORDER BY category, difficulty`
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/interview-questions', async (req, res) => {
  try {
    const { question, category, difficulty, answer, tags } = req.body;
    const r = await pool.query(
      `INSERT INTO interview_questions (question, category, difficulty, expected_answer, tags)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [question, category || 'General', difficulty || 'Medium', answer || '', tags || '']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
