// backend/src/modules/hr/assessments.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => req.scope?.company_id ?? null;
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','lnd_admin','HR','Admin','SuperAdmin'];

/* ── GET /assessments ──────────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  const { program_id } = req.query;
  const sc = companyId != null ? ` AND (a.company_id IS NULL OR a.company_id=${companyId})` : '';
  let where = `WHERE a.is_active=true${sc}`;
  if (program_id) where += ` AND a.program_id=${parseInt(program_id)}`;
  try {
    const { rows } = await pool.query(`
      SELECT a.*, tp.title AS program_title,
             COUNT(DISTINCT aq.id) AS question_count,
             COUNT(DISTINCT aa.id) AS attempt_count,
             ROUND(AVG(aa.score_pct),1) AS avg_score
      FROM   assessments a
      LEFT JOIN training_programs   tp ON tp.id=a.program_id
      LEFT JOIN assessment_questions aq ON aq.assessment_id=a.id
      LEFT JOIN assessment_attempts  aa ON aa.assessment_id=a.id AND aa.submitted_at IS NOT NULL
      ${where}
      GROUP BY a.id, tp.title ORDER BY a.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /assessments ─────────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { program_id, title, description, pass_score = 70, max_attempts = 3, time_limit_mins } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO assessments (program_id,title,description,pass_score,max_attempts,time_limit_mins,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [program_id||null, title, description||null, pass_score, max_attempts, time_limit_mins||null, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /assessments/:id ──────────────────────────────────── */
router.put('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { title, description, pass_score, max_attempts, time_limit_mins, is_active } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE assessments SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        pass_score=COALESCE($3,pass_score), max_attempts=COALESCE($4,max_attempts),
        time_limit_mins=COALESCE($5,time_limit_mins), is_active=COALESCE($6,is_active)
      WHERE id=$7 RETURNING *`,
      [title, description, pass_score, max_attempts, time_limit_mins, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /assessments/:id ───────────────────────────────── */
router.delete('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`UPDATE assessments SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Assessment archived' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /assessments/:id/questions ────────────────────────── */
router.get('/:id/questions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM assessment_questions WHERE assessment_id=$1 ORDER BY sequence_order`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /assessments/:id/questions ────────────────────────── */
router.put('/:id/questions', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { questions = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM assessment_questions WHERE assessment_id=$1`, [req.params.id]);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await client.query(`
        INSERT INTO assessment_questions
          (assessment_id,question_text,question_type,options,correct_answer,marks,sequence_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, q.question_text, q.question_type||'mcq',
         JSON.stringify(q.options||[]), q.correct_answer||null, q.marks||1, i+1]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Questions saved', count: questions.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ── POST /assessments/:id/start ───────────────────────────── */
router.post('/:id/start', async (req, res) => {
  const employeeId = req.user?.employee_id || req.body?.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'employee_id required' });
  const companyId = cid(req);
  try {
    const assessRes = await pool.query(`SELECT * FROM assessments WHERE id=$1 AND is_active=true`, [req.params.id]);
    if (!assessRes.rows.length) return res.status(404).json({ error: 'Assessment not found' });
    const assessment = assessRes.rows[0];

    // Check attempt count
    const attRes = await pool.query(
      `SELECT COUNT(*) FROM assessment_attempts WHERE assessment_id=$1 AND employee_id=$2 AND submitted_at IS NOT NULL`,
      [req.params.id, employeeId]
    );
    const prevAttempts = parseInt(attRes.rows[0].count);
    if (prevAttempts >= assessment.max_attempts)
      return res.status(409).json({ error: `Maximum ${assessment.max_attempts} attempts reached` });

    const { rows } = await pool.query(`
      INSERT INTO assessment_attempts (assessment_id,employee_id,attempt_number,company_id)
      VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, employeeId, prevAttempts + 1, companyId]
    );
    // Return questions without correct_answer exposed
    const { rows: questions } = await pool.query(
      `SELECT id,question_text,question_type,options,marks,sequence_order
       FROM assessment_questions WHERE assessment_id=$1 ORDER BY sequence_order`,
      [req.params.id]
    );
    res.json({ attempt: rows[0], questions, time_limit_mins: assessment.time_limit_mins });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /assessments/attempts/:id/submit ─────────────────── */
router.post('/attempts/:id/submit', async (req, res) => {
  const { answers = {} } = req.body; // { question_id: answer_text }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: attempt } = await client.query(
      `SELECT aa.*, a.pass_score FROM assessment_attempts aa
       JOIN assessments a ON a.id=aa.assessment_id
       WHERE aa.id=$1 AND aa.submitted_at IS NULL`,
      [req.params.id]
    );
    if (!attempt.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Attempt not found or already submitted' }); }
    const att = attempt[0];

    const { rows: questions } = await client.query(
      `SELECT * FROM assessment_questions WHERE assessment_id=$1`, [att.assessment_id]
    );
    let earned = 0, total = 0;
    for (const q of questions) {
      total += q.marks;
      const givenAnswer = answers[q.id];
      if (q.question_type === 'mcq' || q.question_type === 'true_false') {
        if (String(givenAnswer).trim().toLowerCase() === String(q.correct_answer).trim().toLowerCase())
          earned += q.marks;
      } else {
        // Short answer — partial credit
        if (givenAnswer && givenAnswer.trim().length > 0) earned += Math.round(q.marks * 0.5);
      }
    }
    const scorePct  = total > 0 ? Math.round((earned / total) * 100) : 0;
    const passed    = scorePct >= att.pass_score;

    const { rows: updated } = await client.query(`
      UPDATE assessment_attempts SET
        submitted_at=NOW(), score=$1, max_score=$2, score_pct=$3, passed=$4, answers=$5
      WHERE id=$6 RETURNING *`,
      [earned, total, scorePct, passed, JSON.stringify(answers), req.params.id]
    );

    // If passed and linked to enrollment, mark skill proficiency
    if (passed && att.enrollment_id) {
      const progRes = await client.query(
        `SELECT tp.category FROM training_enrollments te
         JOIN training_programs tp ON tp.id=te.program_id WHERE te.id=$1`,
        [att.enrollment_id]
      );
      if (progRes.rows[0]) {
        await client.query(`
          INSERT INTO skill_matrix (employee_id,skill_name,category,proficiency_level,certified,company_id)
          VALUES ($1,$2,$3,4,true,$4)
          ON CONFLICT ON CONSTRAINT uq_skill_matrix_emp_skill DO UPDATE SET
            proficiency_level=GREATEST(skill_matrix.proficiency_level,4), last_assessed=CURRENT_DATE`,
          [att.employee_id, progRes.rows[0].category, progRes.rows[0].category, att.company_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ...updated[0], earned, total, feedback: passed ? 'Congratulations! You passed.' : `Score: ${scorePct}%. Pass mark: ${att.pass_score}%.` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ── GET /assessments/:id/results ──────────────────────────── */
router.get('/:id/results', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND aa.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT aa.*, e.name AS employee_name, e.department,
             RANK() OVER (PARTITION BY aa.employee_id ORDER BY aa.attempt_number DESC) AS latest
      FROM   assessment_attempts aa
      JOIN   employees e ON e.id=aa.employee_id
      WHERE  aa.assessment_id=$1 AND aa.submitted_at IS NOT NULL${sc}
      ORDER  BY e.name, aa.attempt_number`, [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /assessments/employee/:employee_id/history ─────────── */
router.get('/employee/:employee_id/history', async (req, res) => {
  const companyId = cid(req);
  const sc = companyId != null ? ` AND aa.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT aa.*, a.title AS assessment_title, a.pass_score,
             tp.title AS program_title
      FROM   assessment_attempts aa
      JOIN   assessments a ON a.id=aa.assessment_id
      LEFT JOIN training_programs tp ON tp.id=a.program_id
      WHERE  aa.employee_id=$1 AND aa.submitted_at IS NOT NULL${sc}
      ORDER  BY aa.submitted_at DESC`, [req.params.employee_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
