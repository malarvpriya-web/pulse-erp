// backend/src/modules/hr/knowledge.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','lnd_admin','HR','Admin','SuperAdmin'];

function sc(companyId, alias = '') {
  const col = alias ? `${alias}.company_id` : 'company_id';
  return companyId != null ? ` AND (${col} IS NULL OR ${col}=${companyId})` : '';
}

/* ── GET /knowledge ────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  const { category, doc_type, search } = req.query;
  let where = `WHERE kd.is_active=true${sc(companyId,'kd')}`;
  if (category) where += ` AND kd.category='${category.replace(/'/g,"''")}'`;
  if (doc_type) where += ` AND kd.doc_type='${doc_type.replace(/'/g,"''")}'`;
  if (search)   where += ` AND (kd.title ILIKE '%${search.replace(/'/g,"''")  }%' OR kd.description ILIKE '%${search.replace(/'/g,"''")}%')`;
  try {
    const { rows } = await pool.query(`
      SELECT kd.*, e.name AS created_by_name,
             e2.name AS updated_by_name
      FROM   knowledge_documents kd
      LEFT JOIN employees e  ON e.id=kd.created_by_employee_id
      LEFT JOIN employees e2 ON e2.id=kd.updated_by_employee_id
      ${where}
      ORDER  BY kd.category, kd.title`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /knowledge/:id ─────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT kd.*, e.name AS created_by_name
      FROM   knowledge_documents kd
      LEFT JOIN employees e ON e.id=kd.created_by_employee_id
      WHERE  kd.id=$1 AND kd.is_active=true`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Increment view count
    await pool.query(`UPDATE knowledge_documents SET view_count=COALESCE(view_count,0)+1 WHERE id=$1`, [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /knowledge ────────────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const {
    title, doc_type = 'sop', category, description,
    content, file_url, version = '1.0',
    applicable_departments, applicable_roles, tags, review_due_date,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const companyId = cid(req);
  const createdBy = req.user?.employee_id || null;
  try {
    const { rows } = await pool.query(`
      INSERT INTO knowledge_documents
        (title,doc_type,category,description,content,file_url,version,
         applicable_departments,applicable_roles,tags,review_due_date,
         created_by_employee_id,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [title, doc_type, category||null, description||null, content||null, file_url||null,
       version, applicable_departments||null, applicable_roles||null,
       tags||null, review_due_date||null, createdBy, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /knowledge/:id ─────────────────────────────────────── */
router.put('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const {
    title, doc_type, category, description, content, file_url,
    version, applicable_departments, applicable_roles, tags, review_due_date, is_active,
  } = req.body;
  const updatedBy = req.user?.employee_id || null;
  try {
    const { rows } = await pool.query(`
      UPDATE knowledge_documents SET
        title                  = COALESCE($1, title),
        doc_type               = COALESCE($2, doc_type),
        category               = COALESCE($3, category),
        description            = COALESCE($4, description),
        content                = COALESCE($5, content),
        file_url               = COALESCE($6, file_url),
        version                = COALESCE($7, version),
        applicable_departments = COALESCE($8, applicable_departments),
        applicable_roles       = COALESCE($9, applicable_roles),
        tags                   = COALESCE($10, tags),
        review_due_date        = COALESCE($11, review_due_date),
        is_active              = COALESCE($12, is_active),
        updated_by_employee_id = $13,
        updated_at             = NOW()
      WHERE id=$14 RETURNING *`,
      [title, doc_type, category, description, content, file_url, version,
       applicable_departments, applicable_roles, tags, review_due_date, is_active, updatedBy, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /knowledge/:id ─────────────────────────────────── */
router.delete('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`UPDATE knowledge_documents SET is_active=false, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Document archived' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /knowledge/categories/list ──────────────────────────── */
router.get('/categories/list', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT category, doc_type,
             COUNT(*) AS document_count
      FROM   knowledge_documents
      WHERE  is_active=true${sc(companyId)}
      GROUP  BY category, doc_type ORDER BY category`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
