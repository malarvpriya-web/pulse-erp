// backend/src/modules/hr/trainers.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => req.scope?.company_id ?? null;
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','lnd_admin','HR','Admin','SuperAdmin'];

/* ── GET /trainers ─────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND (t.company_id IS NULL OR t.company_id=${companyId})` : '';
  try {
    const { rows } = await pool.query(`
      SELECT t.*, e.name AS employee_full_name,
             COUNT(DISTINCT tp.id) AS programs_count
      FROM   trainers t
      LEFT JOIN employees          e  ON e.id=t.employee_id
      LEFT JOIN training_programs  tp ON tp.trainer_id=t.id AND tp.deleted_at IS NULL
      WHERE  t.is_active=true${sc}
      GROUP  BY t.id, e.name ORDER BY t.name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /trainers ────────────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, trainer_type = 'internal', employee_id, email, phone, specialization } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO trainers (name,trainer_type,employee_id,email,phone,specialization,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, trainer_type, employee_id||null, email||null, phone||null, specialization||null, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /trainers/:id ─────────────────────────────────────── */
router.put('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, trainer_type, employee_id, email, phone, specialization, is_active } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE trainers SET
        name=COALESCE($1,name), trainer_type=COALESCE($2,trainer_type),
        employee_id=COALESCE($3,employee_id), email=COALESCE($4,email),
        phone=COALESCE($5,phone), specialization=COALESCE($6,specialization),
        is_active=COALESCE($7,is_active)
      WHERE id=$8 RETURNING *`,
      [name, trainer_type, employee_id, email, phone, specialization, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /trainers/:id ──────────────────────────────────── */
router.delete('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`UPDATE trainers SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Trainer deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /trainers/:id/programs ────────────────────────────── */
router.get('/:id/programs', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND (tp.company_id IS NULL OR tp.company_id=${companyId})` : '';
  try {
    const { rows } = await pool.query(`
      SELECT tp.*,
             COUNT(DISTINCT te.id)                                                AS enrolled_count,
             COUNT(DISTINCT CASE WHEN te.status='completed' THEN te.id END)      AS completed_count,
             ROUND(AVG(te.feedback_rating),1)                                    AS avg_rating
      FROM   training_programs tp
      LEFT JOIN training_enrollments te ON te.program_id=tp.id
      WHERE  tp.trainer_id=$1 AND tp.deleted_at IS NULL${sc}
      GROUP  BY tp.id ORDER BY tp.scheduled_date DESC`, [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
