/**
 * My Interviews — the interviewer's side of recruitment (2026-11-17).
 *
 * Interviewers are often engineers or managers with no Recruitment access, so
 * they could not see the interviews they were booked on or give feedback
 * (recruitment page audit follow-up). These routes need no recruitment
 * permission: every one is scoped to the CALLER'S employee record, i.e. only
 * interviews where they are the lead interviewer or on the panel. They see what
 * they need to interview — name, role, current job, experience, skills, the
 * résumé (secureFiles.routes.js interviewPanelAccess) and the chosen
 * questions — and nothing else from the candidate database.
 *
 * The outcome that moves the candidate (submit-feedback) stays with the
 * recruiter; an interviewer records their own assessment here.
 */
import express from 'express';
import pool from '../../shared/db.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { respondError } from '../../../shared/pgErrors.js';
import { logAudit } from '../../../services/AuditService.js';
import recruitmentRepository from '../repositories/recruitment.repository.js';
import candidateIntelligence from '../repositories/candidateIntelligence.repository.js';
import { actorNameOf } from '../actorName.js';

const router = express.Router();
const RECOMMENDATIONS = ['strong_hire', 'hire', 'hold', 'reject'];
const ROUND_LABELS = { '1st_level': '1st Level Interview', '2nd_level': '2nd Level Interview',
  technical: 'Technical Interview', hr: 'HR Interview', final: 'Final Interview' };

const MINE = `(s.interviewer_id = $2 OR s.panel_employee_ids @> to_jsonb($2::int))`;

async function me(req, res) {
  const emp = await employeeOf(req, pool);
  if (!emp) { res.status(403).json({ error: 'Your login is not linked to an employee record.' }); return null; }
  return emp;
}

// GET /my-interviews?scope=upcoming|past — interviews I am on.
router.get('/', async (req, res) => {
  try {
    const emp = await me(req, res); if (!emp) return;
    const past = req.query.scope === 'past';
    const { rows } = await pool.query(
      `SELECT s.id, s.candidate_id, s.interview_date, s.interview_time, s.interview_mode, s.interview_round,
              s.meeting_link, s.status, s.notes, s.question_ids, (s.interviewer_id = $2) AS is_lead,
              le.name AS lead_name,
              c.full_name AS candidate_name, c.current_designation, c.current_company, c.experience_years,
              c.notice_period_days, c.qualification, c.skills, c.current_city, c.location,
              (c.resume_file_url IS NOT NULL OR c.resume_url IS NOT NULL OR c.resume_gdrive_url IS NOT NULL) AS has_resume,
              c.resume_file_url, c.resume_url, c.resume_gdrive_url,
              COALESCE(jo.job_title, cjo.job_title) AS job_title,
              (SELECT row_to_json(n) FROM (SELECT id, rating, recommendation, comments, created_at
                                             FROM interview_notes WHERE interview_id = s.id AND interviewer_id = $2
                                            ORDER BY id DESC LIMIT 1) n) AS my_feedback,
              (SELECT COALESCE(json_agg(json_build_object('id', q.id, 'question', q.question, 'category', q.category,
                                                          'expected_answer', q.expected_answer) ORDER BY q.category, q.id), '[]'::json)
                 FROM interview_questions q
                WHERE q.company_id = s.company_id
                  AND q.id IN (SELECT (jsonb_array_elements_text(s.question_ids))::int)) AS questions
         FROM interview_schedules s
         JOIN candidates c ON c.id = s.candidate_id AND c.deleted_at IS NULL
         LEFT JOIN employees le ON le.id = s.interviewer_id
         LEFT JOIN job_openings jo ON jo.id = s.job_opening_id
         LEFT JOIN job_openings cjo ON cjo.id = c.applied_job_id
        WHERE s.company_id = $1 AND s.deleted_at IS NULL AND ${MINE}
          AND ${past
            ? `(s.status = 'completed' OR s.interview_date < CURRENT_DATE) AND s.interview_date >= CURRENT_DATE - 90`
            : `s.status = 'scheduled'`}
        ORDER BY s.interview_date ${past ? 'DESC' : 'ASC'}, s.interview_time
        LIMIT 100`,
      [companyOf(req), emp]);
    res.json(rows);
  } catch (error) { respondError(res, error); }
});

// GET /my-interviews/summary — count of interviews waiting for my feedback
// (held, or today, and no note from me yet). Drives the Home card / bell.
router.get('/summary', async (req, res) => {
  try {
    const emp = await employeeOf(req, pool);
    if (!emp) return res.json({ is_interviewer: false, upcoming: 0, feedback_due: 0 });
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE s.status = 'scheduled')::int AS upcoming,
              COUNT(*) FILTER (WHERE s.status <> 'cancelled' AND s.interview_date <= CURRENT_DATE
                                 AND NOT EXISTS (SELECT 1 FROM interview_notes n WHERE n.interview_id = s.id AND n.interviewer_id = $2))::int AS feedback_due
         FROM interview_schedules s
        WHERE s.company_id = $1 AND s.deleted_at IS NULL AND ${MINE}
          AND s.interview_date >= CURRENT_DATE - 30`, [companyOf(req), emp]);
    res.json({ is_interviewer: r.upcoming + r.feedback_due > 0, ...r });
  } catch (error) { respondError(res, error); }
});

// POST /my-interviews/:id/feedback — my assessment for one interview. One per
// interviewer per interview; sending it again updates it.
router.post('/:id/feedback', async (req, res) => {
  try {
    const emp = await me(req, res); if (!emp) return;
    const { rows: [iv] } = await pool.query(
      `SELECT s.* FROM interview_schedules s
        WHERE s.id::text = $3 AND s.company_id = $1 AND s.deleted_at IS NULL AND ${MINE}`,
      [companyOf(req), emp, String(req.params.id)]);
    if (!iv) return res.status(404).json({ error: 'Interview not found, or you are not on its panel.' });
    if (iv.status === 'cancelled') return res.status(409).json({ error: 'This interview was cancelled.' });
    // Feedback before the interview has happened is not feedback. Compared in SQL
    // so "today" is the business date (timezone.js), not the JS Date's UTC day.
    const { rows: [{ future }] } = await pool.query(`SELECT interview_date > CURRENT_DATE AS future FROM interview_schedules WHERE id = $1`, [iv.id]);
    if (future) return res.status(409).json({ error: 'Feedback opens on the day of the interview.' });

    const { rating, recommendation, comments } = req.body || {};
    if (!RECOMMENDATIONS.includes(recommendation)) {
      return res.status(400).json({ error: 'Choose a recommendation: strong hire, hire, hold or do not hire.' });
    }
    const r = rating === '' || rating == null ? null : Number(rating);
    if (r != null && !(r >= 1 && r <= 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    const text = comments == null ? null : String(comments).slice(0, 5000);
    const round = ROUND_LABELS[iv.interview_round] || 'Interview';

    const { rows: [existing] } = await pool.query(
      `SELECT id FROM interview_notes WHERE interview_id = $1 AND interviewer_id = $2 ORDER BY id DESC LIMIT 1`, [iv.id, emp]);
    let note;
    if (existing) {
      ({ rows: [note] } = await pool.query(
        `UPDATE interview_notes SET rating = $2, recommendation = $3, comments = $4, updated_at = NOW()
          WHERE id = $1 RETURNING *`, [existing.id, r, recommendation, text]));
    } else {
      ({ rows: [note] } = await pool.query(
        `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_round, rating, comments, recommendation, interview_id, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [iv.candidate_id, emp, round, r, text, recommendation, iv.id, iv.company_id]));
    }
    await recruitmentRepository.refreshOverallRating(iv.candidate_id);
    await candidateIntelligence.recordActivity({
      company_id: iv.company_id, candidate_id: iv.candidate_id, event_type: 'interview_feedback_added',
      summary: `${existing ? 'Updated' : 'Panel'} feedback: ${recommendation.replace('_', ' ')}${r ? ` (${r}/5)` : ''}`,
      detail: { interview_id: iv.id, interviewer_id: emp, has_comments: Boolean(text) },
      actor_user_id: req.user?.userId ?? req.user?.id ?? null, actor_name: await actorNameOf(req),
    }).catch(() => {});
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: note.id, recordType: 'interview_note',
      action: existing ? 'update' : 'create', newData: { interview_id: iv.id, rating: r, recommendation }, req });
    res.status(existing ? 200 : 201).json(note);
  } catch (error) { respondError(res, error); }
});

export default router;
