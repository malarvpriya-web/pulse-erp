import express from 'express';
import multer from 'multer';
import recruitmentRepository from '../repositories/recruitment.repository.js';
import { uploadFile } from '../../../services/StorageService.js';
import pool from '../../shared/db.js';
import {
  createJobFolderStructure,
  uploadResume,
  moveResumeOnStageChange,
} from '../../../services/recruitmentDriveService.js';
import notificationsRepository from '../../notifications/repositories/notifications.repository.js';
import { logAudit } from '../../../services/AuditService.js';
import { triggerEmail } from '../../../services/emailTrigger.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { resolveRange, dimension } from '../../../shared/dashboardFilters.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
// Turns Postgres constraint violations into actionable 4xx responses instead of
// the blanket 500s these handlers used to return. See shared/pgErrors.js.
import { respondError, httpFromPgError } from '../../../shared/pgErrors.js';
// Request-schema validation — the layer pgErrors.js's own header calls out as the
// thing it is not. Rejects bad input before it reaches Postgres, and rejects values
// Postgres would happily accept: the status columns in this module are bare varchars
// with no CHECK constraint, so `status: 'banana'` used to insert and then render as
// an unknown badge on every page that read it.
import { validateBody, validatePatch } from '../../../shared/requestSchema.js';
import {
  requisitionSchema, openingSchema, candidateSchema, moveStageSchema,
  interviewSchema, interviewNoteSchema, submitFeedbackSchema,
  offerSchema, emailTemplateSchema,
} from './recruitment.schemas.js';

// GET → view, POST create → add, PUT/POST-mutation → edit, DELETE → delete.
// The 'recruitment' role_permissions matrix (manager/department_head/hr/hr_manager/
// hr_exec/employee, base seed 20260428000001 + granular seeds 20260529000001/
// 20260716000009) is already fully populated for every role that has frontend
// access to this module — this was previously enforced only by the frontend
// nav/menu gate, so any authenticated user of any role could call these routes
// directly regardless of their actual role_permissions row.
const view   = requirePermission('recruitment', 'view');
const add    = requirePermission('recruitment', 'add');
const edit   = requirePermission('recruitment', 'edit');
const remove = requirePermission('recruitment', 'delete');

const notify = (userId, module, recordId, message) => {
  if (!userId) return;
  notificationsRepository.create({
    user_id: userId,
    title: (message || 'Notification').slice(0, 100),
    message,
    module_name: module,
    reference_id: recordId,
    notification_type: 'info',
  }).catch(() => {});
};

const router = express.Router();

// Bootstrap: create interview_schedules and offer_letters tables if they don't exist
//
// candidate_id/job_opening_id were originally typed UUID here, but
// candidates.id and job_openings.id are both `integer` — every INSERT
// (createOffer, interview scheduling) that passed a real candidate/job id
// would fail immediately with "invalid input syntax for type uuid", and
// every JOIN against candidates.id (e.g. the auto-creation-trigger
// endpoint's own offer lookup) would throw "operator does not exist: uuid =
// integer" instead. In practice this meant offer letters and interview
// schedules could never actually be created against a real candidate.
pool.query(`
  CREATE TABLE IF NOT EXISTS interview_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id INTEGER,
    interview_date DATE NOT NULL DEFAULT CURRENT_DATE,
    interview_time TIME,
    interview_mode VARCHAR(20),
    meeting_link VARCHAR(500),
    interviewer_id INTEGER,
    status VARCHAR(20) DEFAULT 'scheduled',
    notes TEXT,
    company_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS offer_letters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id INTEGER,
    job_opening_id INTEGER,
    offered_salary DECIMAL(15,2) DEFAULT 0,
    joining_date DATE DEFAULT CURRENT_DATE,
    offer_status VARCHAR(20) DEFAULT 'draft',
    offer_sent_date DATE,
    response_date DATE,
    notes TEXT,
    company_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
  );
`).catch(() => {});

// Migrate any already-created copies of the two tables above off the wrong
// UUID typing. Both tables were (per the CREATE statements' own IF NOT
// EXISTS) never successfully written to with a real candidate/job id, so
// these columns should be empty/unused wherever this has already run —
// each ALTER is independently caught so one succeeding or failing never
// blocks the others.
for (const stmt of [
  `ALTER TABLE interview_schedules ALTER COLUMN candidate_id TYPE INTEGER USING NULLIF(candidate_id::text, '')::integer`,
  `ALTER TABLE offer_letters ALTER COLUMN candidate_id TYPE INTEGER USING NULLIF(candidate_id::text, '')::integer`,
  `ALTER TABLE offer_letters ALTER COLUMN job_opening_id TYPE INTEGER USING NULLIF(job_opening_id::text, '')::integer`,
]) {
  pool.query(stmt).catch(() => {});
}

const ALLOWED_RESUME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_RESUME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error('Only PDF and Word documents are allowed for resumes'), { status: 415 }));
  },
});

// Helper — extract company_id strictly from JWT (never from query params — prevents spoofing)
const cid = (req) => companyOf(req);

// ==================== DASHBOARD SUMMARY ====================
const getDashboardSummary = async (req, res) => {
  try {
    const range = resolveRange(req.query, { defaultPeriod: 'fytd' });
    const department = dimension(req.query, 'department');
    const data = await recruitmentRepository.getDashboard(cid(req), {
      from: range.from, to: range.to, department,
    });
    res.json({ ...data, period: range.period, period_label: range.label, department });
  } catch (error) {
    respondError(res, error);
  }
};

// Dimension options for the dashboard filter bar. Declared before any
// `/:id`-style route in this file so it isn't captured as a param.
router.get('/filter-options', view, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT department FROM job_openings
        WHERE department IS NOT NULL AND TRIM(department) <> '' AND deleted_at IS NULL
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY department`,
      [cid(req)]
    );
    res.json({ departments: rows.map(r => r.department) });
  } catch { res.json({ departments: [] }); }
});
// /dashboard-summary is the canonical path (used by RecruitmentDashboard.jsx);
// /dashboard has no current frontend caller but is kept as an alias for any
// external/API consumer rather than removed outright.
router.get('/dashboard-summary', view, getDashboardSummary);
router.get('/dashboard', view, getDashboardSummary);

// ==================== PIPELINE SUMMARY ====================
router.get('/pipeline-summary', view, async (req, res) => {
  try {
    const rows = await recruitmentRepository.getPipelineSummary(cid(req));
    res.json(rows);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== JOB REQUISITIONS ====================
router.get('/requisitions', view, async (req, res) => {
  try {
    const requisitions = await recruitmentRepository.findRequisitions({
      ...req.query, company_id: cid(req),
    });
    res.json(requisitions);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/requisitions/:id', view, async (req, res) => {
  try {
    const requisition = await recruitmentRepository.findRequisitionById(req.params.id, cid(req));
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    res.json(requisition);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/requisitions', add, validateBody(requisitionSchema), async (req, res) => {
  try {
    const requisition = await recruitmentRepository.createRequisition({
      ...req.body, company_id: cid(req),
    });
    res.status(201).json(requisition);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/requisitions/:id', edit, validatePatch(requisitionSchema), async (req, res) => {
  try {
    // 'approved' is now gated through the Approval Center (POST
    // /approvals/requisition:<id>/approve, which requires an approver role —
    // see approvals.controller.js). Blocking it here too, not just omitting a
    // button in JobRequisitionPipeline.jsx, so the enforcement lives in the
    // API and can't be bypassed by calling this endpoint directly.
    if (req.body.status === 'approved') {
      return res.status(400).json({
        error: 'Requisitions must be approved through the Approval Center, not edited directly.',
      });
    }
    const requisition = await recruitmentRepository.updateRequisition(req.params.id, req.body, cid(req));
    res.json(requisition);
  } catch (error) {
    respondError(res, error);
  }
});

router.delete('/requisitions/:id', remove, async (req, res) => {
  try {
    await recruitmentRepository.deleteRequisition(req.params.id, cid(req));
    res.json({ message: 'Requisition deleted successfully' });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== JOB OPENINGS ====================
router.get('/openings', view, async (req, res) => {
  try {
    const openings = await recruitmentRepository.findOpenings({
      ...req.query, company_id: cid(req),
    });
    res.json(openings);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/openings/:id', view, async (req, res) => {
  try {
    const opening = await recruitmentRepository.findOpeningById(req.params.id, cid(req));
    if (!opening) return res.status(404).json({ error: 'Opening not found' });
    res.json(opening);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/openings', add, validateBody(openingSchema), async (req, res) => {
  try {
    // Requisitions must be approved before a job opening can be created against them.
    // createOpening() itself accepted any requisition_id (or none) with no status check and
    // unconditionally flipped the requisition to 'open' once referenced — this was the actual
    // enforcement gap, since editing a requisition's status straight to 'approved' was already
    // blocked above and routed through the Approval Center, but nothing stopped HR from
    // sidestepping that entirely by just creating the opening.
    //
    // The check used to live here, one unlocked statement ahead of the insert, which left a
    // race window where two concurrent requests both saw 'approved'. It now lives inside
    // createOpening()'s transaction behind a SELECT ... FOR UPDATE on the requisition row,
    // so it is enforced atomically; this route just surfaces the resulting status code.
    const opening = await recruitmentRepository.createOpening({
      ...req.body, company_id: cid(req),
    });
    // Create Google Drive folder structure async (non-blocking)
    const title = opening.job_title || req.body.job_title || 'Job';
    createJobFolderStructure(title, opening.id).catch(err =>
      console.warn('[Drive] createJobFolderStructure failed:', err.message)
    );
    res.status(201).json(opening);
  } catch (error) {
    // createOpening() tags the approval-gate rejections with 404/400; without this
    // they would collapse into a blanket 500 and the UI would show no reason.
    respondError(res, error);
  }
});

router.put('/openings/:id', edit, validatePatch(openingSchema), async (req, res) => {
  try {
    // Same approval guard as POST /openings — otherwise an unapproved requisition could be
    // linked in later via edit instead of at creation time.
    if (req.body.requisition_id) {
      const requisition = await recruitmentRepository.findRequisitionById(req.body.requisition_id, cid(req));
      if (!requisition) {
        return res.status(404).json({ error: 'Requisition not found.' });
      }
      if (requisition.status !== 'approved') {
        return res.status(400).json({
          error: 'This requisition has not been approved yet. Job openings can only be linked to an approved requisition.',
        });
      }
    }
    const opening = await recruitmentRepository.updateOpening(req.params.id, req.body, cid(req));
    res.json(opening);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== CANDIDATES ====================
router.get('/candidates', view, async (req, res) => {
  try {
    const candidates = await recruitmentRepository.findCandidates({
      ...req.query, company_id: cid(req),
    });
    res.json(candidates);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/candidates/:id', view, async (req, res) => {
  try {
    const candidate = await recruitmentRepository.findCandidateById(req.params.id, cid(req));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json(candidate);
  } catch (error) {
    respondError(res, error);
  }
});

// validateBody sits after multer, not before it: this route is multipart, so
// req.body does not exist until upload.single() has parsed the stream.
router.post('/candidates', add, upload.single('resume'), validateBody(candidateSchema), async (req, res) => {
  try {
    const data = { ...req.body, company_id: cid(req) };
    if (req.file) {
      data.resume_file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    }
    const candidate = await recruitmentRepository.createCandidate(data);

    // Notify recruiter of new application
    notify(req.user?.userId ?? req.user?.id, 'recruitment', candidate.id,
      `New application: ${candidate.full_name} applied`);
    triggerEmail('application_received', {
      candidate_name:  candidate.full_name,
      candidate_email: candidate.email,
      job_title:       candidate.job_title || '',
    }, cid(req));

    // Upload to Google Drive if file present
    if (req.file && candidate.applied_job_id) {
      uploadResume(
        candidate.id,
        candidate.applied_job_id,
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      ).catch(err => console.warn('[Drive] uploadResume failed:', err.message));
    }

    res.status(201).json(candidate);
  } catch (error) {
    // 409 (duplicate candidate / closed opening) must not surface as a 500 —
    // the frontend shows this message directly to the recruiter. Not using
    // respondError() here because this response carries an extra field the
    // recruiter UI needs (a link to the candidate they just collided with).
    const mapped = httpFromPgError(error);
    res.status(mapped?.status ?? 500).json({
      error: mapped?.message ?? error.message,
      existing_candidate_id: error.existingCandidateId,
    });
  }
});

router.post('/candidates/bulk', add, upload.array('resumes'), async (req, res) => {
  try {
    const candidates = JSON.parse(req.body.candidates);
    if (req.files?.length) {
      await Promise.all(req.files.map(async (file, i) => {
        if (candidates[i]) {
          candidates[i].resume_file_url = await uploadFile(file.buffer, file.originalname, file.mimetype);
        }
      }));
    }
    const results = await recruitmentRepository.bulkCreateCandidates(
      candidates.map(c => ({ ...c, company_id: cid(req) }))
    );
    // Duplicates are skipped rather than failing the whole upload — report both
    // halves so the uploader knows exactly what landed and what didn't.
    res.status(201).json({
      created: Array.from(results),
      created_count: results.length,
      skipped: results.skipped || [],
      skipped_count: (results.skipped || []).length,
    });
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/candidates/:id', edit, validatePatch(candidateSchema), async (req, res) => {
  try {
    const candidate = await recruitmentRepository.updateCandidate(req.params.id, req.body, cid(req));
    res.json(candidate);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/candidates/:id/move-stage', edit, validateBody(moveStageSchema), async (req, res) => {
  try {
    const { new_stage, moved_by, notes } = req.body;
    await recruitmentRepository.moveCandidateStage(req.params.id, new_stage, moved_by, notes, cid(req));

    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'candidate', action: 'stage_change', newData: { stage: new_stage }, req });

    // Move resume in Google Drive async (non-blocking)
    moveResumeOnStageChange(req.params.id, new_stage).catch(err =>
      console.warn('[Drive] moveResumeOnStageChange failed:', err.message)
    );

    // Auto-create the employee record the moment a candidate reaches Hired
    // (kanban drag/stage-button on CandidatePipeline/CandidateDetail/
    // RecruitmentDashboard all land here) instead of leaving it for a human
    // to find in the Auto-Creation queue. Fire-and-forget: a slow/failed
    // employee creation shouldn't block or fail the stage-move response —
    // failures land in recruitment_employee_creation_log with status
    // 'failed', same as today's manual-trigger failure path, and the queue
    // page still offers a manual retry. See AUTOMATION_OPPORTUNITY_AUDIT.md §10.1.
    if ((new_stage || '').toLowerCase() === 'hired') {
      recruitmentRepository.autoCreateEmployeeFromCandidate(
        req.params.id, cid(req), req.user?.userId ?? req.user?.id ?? null
      ).catch(err => console.warn('[Recruitment] auto-create-on-hire failed:', err.message));
    }

    // Same auto-draft as the submit-feedback path (AUTOMATION_OPPORTUNITY_AUDIT.md
    // §10.3) for candidates moved to Offer directly via kanban/stage-button
    // rather than through interview feedback. autoDraftOfferForCandidate is
    // idempotent, so this can't double-draft one already created there.
    if ((new_stage || '').toLowerCase() === 'offer') {
      recruitmentRepository.autoDraftOfferForCandidate(req.params.id, cid(req))
        .catch(err => console.warn('[Recruitment] auto-draft-offer failed:', err.message));
    }

    res.json({ message: 'Candidate moved to new stage' });
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/candidates/:id/history', view, async (req, res) => {
  try {
    const history = await recruitmentRepository.getCandidateStageHistory(req.params.id, cid(req));
    res.json(history);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== HIRE CANDIDATE ====================
// Routed through autoCreateEmployeeFromCandidate() rather than calling
// hireCandidate() directly. This endpoint used to be the one hire path that
// skipped the 'hired' stage-gate and the recruitment_employee_creation_log
// de-duplication that the other three paths (move-stage → hired, offer-accept,
// manual auto-creation trigger) all go through — so it could mint a second
// employee record, login and payroll enrolment for an already-hired candidate.
// It now shares the exact same guarded, transactional path as the rest.
router.post('/candidates/:id/hire', edit, async (req, res) => {
  try {
    const result = await recruitmentRepository.autoCreateEmployeeFromCandidate(
      req.params.id, cid(req), req.user?.userId ?? req.user?.id ?? null
    );
    if (result.status !== 201) {
      return res.status(result.status).json({ error: result.error, employee_code: result.employee_code });
    }
    const { employee, employeeId } = result;

    // Move resume to Hired folder (non-blocking)
    moveResumeOnStageChange(req.params.id, 'hired').catch(err =>
      console.warn('[Drive] hire moveResume failed:', err.message)
    );

    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'candidate', action: 'hire', newData: { employee_id: employeeId }, req });
    // Notify HR of new hire
    notify(req.user?.userId ?? req.user?.id, 'recruitment', parseInt(req.params.id),
      `${employee.first_name} ${employee.last_name} has been hired and added as employee ${employeeId}`);
    triggerEmail('hired_welcome', {
      candidate_email: employee.company_email || '',
      candidate_name:  `${employee.first_name} ${employee.last_name}`,
      employee_id:     employeeId,
      joining_date:    employee.joining_date  || '',
    }, cid(req));
    res.json({ success: true, employee_id: employeeId, employee });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== PIPELINE ====================
router.get('/pipeline/:job_opening_id', view, async (req, res) => {
  try {
    const pipeline = await recruitmentRepository.getPipelineSummary(cid(req), req.params.job_opening_id);
    res.json(pipeline);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/pipeline/:job_opening_id/:stage', view, async (req, res) => {
  try {
    const candidates = await recruitmentRepository.getCandidatesByStage(
      req.params.job_opening_id, req.params.stage, cid(req)
    );
    res.json(candidates);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== INTERVIEW NOTES ====================
router.post('/interview-notes', add, validateBody(interviewNoteSchema), async (req, res) => {
  try {
    const note = await recruitmentRepository.createInterviewNote(req.body, cid(req));
    res.status(201).json(note);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/interview-notes/:candidate_id', view, async (req, res) => {
  try {
    const notes = await recruitmentRepository.findInterviewNotes(req.params.candidate_id, cid(req));
    res.json(notes);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== INTERVIEWS ====================
router.get('/interviews', view, async (req, res) => {
  try {
    const interviews = await recruitmentRepository.findInterviews({
      ...req.query, company_id: cid(req),
    });
    res.json(interviews);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/interviews', add, validateBody(interviewSchema), async (req, res) => {
  try {
    const interview = await recruitmentRepository.scheduleInterview({
      ...req.body, company_id: cid(req),
    });
    // Notify interviewer
    if (interview.interviewer_id) {
      // employees has no user_id column — this always returned zero rows, so
      // notify() below silently no-op'd on every interview scheduled.
      const empRes = await pool.query('SELECT id AS user_id FROM users WHERE employee_id = $1', [interview.interviewer_id]).catch(() => ({ rows: [] }));
      const interviewerUserId = empRes.rows[0]?.user_id;
      // notifications.reference_id is integer — interview.id is the
      // interview_schedules UUID PK, so passing it here threw 22P02 on every
      // call, silently swallowed by notify()'s own .catch(). Use the
      // candidate's integer id instead, matching every other notify() call
      // in this file.
      notify(interviewerUserId, 'recruitment', interview.candidate_id,
        `Interview scheduled on ${interview.interview_date} — check your calendar`);
    }
    triggerEmail('interview_l1_scheduled', {
      candidate_email:  interview.candidate_email || '',
      candidate_name:   interview.candidate_name  || '',
      interview_date:   interview.interview_date  || '',
      interview_mode:   interview.interview_mode  || '',
    }, cid(req));
    res.status(201).json(interview);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/interviews/:id', edit, validatePatch(interviewSchema), async (req, res) => {
  try {
    const interview = await recruitmentRepository.updateInterview(req.params.id, req.body, cid(req));
    res.json(interview);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== INTERVIEW FEEDBACK + AUTO-PROGRESSION ====================
router.post('/interviews/:id/submit-feedback', edit, validateBody(submitFeedbackSchema), async (req, res) => {
  try {
    const { outcome, rejection_reason, rating, comments } = req.body;

    // `outcome` presence/vocabulary and `rating`'s 1-5 bound are handled by
    // submitFeedbackSchema above. This one stays inline: it is a conditional
    // requirement between two fields, which the schema format cannot express.
    if (outcome === 'rejected' && !rejection_reason) {
      return res.status(400).json({ error: 'rejection_reason is required when outcome is rejected' });
    }

    const company_id = cid(req);

    // 1. Load interview schedule → get candidate_id (previously unscoped —
    // any authenticated user could submit feedback for another company's
    // interview by id)
    const schedRes = await pool.query(
      'SELECT * FROM interview_schedules WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, company_id]
    );
    if (!schedRes.rows.length) return res.status(404).json({ error: 'Interview not found' });
    const schedule = schedRes.rows[0];

    // 2. Load candidate → get current_stage (previously unscoped too)
    const candRes = await pool.query(
      'SELECT * FROM candidates WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)',
      [schedule.candidate_id, company_id]
    );
    if (!candRes.rows.length) return res.status(404).json({ error: 'Candidate not found' });
    const candidate = candRes.rows[0];
    const currentStage = candidate.current_stage;

    // 3. Map current stage to interview round label for the note
    const ROUND_LABELS = {
      '1st_level': '1st Level Interview',
      '2nd_level': '2nd Level Interview',
      'screening':  'Screening',
    };
    const interviewRound = ROUND_LABELS[currentStage] || currentStage;

    // 4. Save interview note
    await pool.query(
      `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_round, rating, comments, recommendation)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [schedule.candidate_id, schedule.interviewer_id, interviewRound,
       rating ?? null, comments ?? null,
       outcome === 'selected' ? 'hire' : 'reject']
    );

    // 5. Mark interview as completed
    await pool.query(
      'UPDATE interview_schedules SET status = $1, updated_at = NOW() WHERE id = $2',
      ['completed', req.params.id]
    );

    // 6. Determine next stage
    let nextStage = null;
    if (outcome === 'selected') {
      if (currentStage === '1st_level') nextStage = '2nd_level';
      else if (currentStage === '2nd_level') nextStage = 'offer';
    } else {
      nextStage = 'not_suitable';
    }

    // 7. Move candidate to next stage
    if (nextStage) {
      await recruitmentRepository.moveCandidateStage(
        schedule.candidate_id,
        nextStage,
        // candidate_stage_history.moved_by FKs employees(id), not users(id) —
        // getCandidateStageHistory's own read joins on employees.
        req.user?.employee_id ?? null,
        rejection_reason || `Interview outcome: ${outcome}`,
        company_id
      );
      moveResumeOnStageChange(String(schedule.candidate_id), nextStage).catch(err =>
        console.warn('[Drive] submit-feedback moveResume failed:', err.message)
      );
    }

    // 8. Notify relevant parties
    if (outcome === 'rejected') {
      triggerEmail('interview_rejected', {
        candidate_email: candidate.email,
        candidate_name:  candidate.full_name,
        rejection_reason,
      }, cid(req));
    } else if (nextStage === '2nd_level') {
      notify(req.user?.userId ?? req.user?.id, 'recruitment', parseInt(schedule.candidate_id),
        `${candidate.full_name} passed L1 — schedule 2nd Level Interview`);
    } else if (nextStage === 'offer') {
      notify(req.user?.userId ?? req.user?.id, 'recruitment', parseInt(schedule.candidate_id),
        `${candidate.full_name} passed L2 — offer letter auto-drafted, review before sending`);
      // Auto-draft the offer instead of leaving the recruiter a bare reminder
      // and a blank form. Fire-and-forget: drafting is a convenience, not a
      // requirement for this response to succeed. See
      // AUTOMATION_OPPORTUNITY_AUDIT.md §10.3.
      recruitmentRepository.autoDraftOfferForCandidate(schedule.candidate_id, company_id)
        .catch(err => console.warn('[Recruitment] auto-draft-offer failed:', err.message));
    }

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment',
      recordId: parseInt(req.params.id),
      recordType: 'interview',
      action: 'submit_feedback',
      newData: { outcome, next_stage: nextStage, rejection_reason },
      req,
    });

    res.json({
      success: true,
      next_stage: nextStage,
      message: nextStage
        ? `Candidate moved to ${nextStage}`
        : 'Feedback saved — stage unchanged',
    });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== EMAIL TEMPLATES ====================
router.get('/email-templates', view, async (req, res) => {
  try {
    const templates = await recruitmentRepository.findEmailTemplates(req.query, cid(req));
    res.json(templates);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/email-templates/:id', view, async (req, res) => {
  try {
    const template = await recruitmentRepository.findEmailTemplateById(req.params.id, cid(req));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/email-templates', add, validateBody(emailTemplateSchema), async (req, res) => {
  try {
    const template = await recruitmentRepository.createEmailTemplate(req.body, cid(req));
    res.status(201).json(template);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/email-templates/:id', edit, validatePatch(emailTemplateSchema), async (req, res) => {
  try {
    const template = await recruitmentRepository.updateEmailTemplate(req.params.id, req.body, cid(req));
    res.json(template);
  } catch (error) {
    respondError(res, error);
  }
});

router.delete('/email-templates/:id', remove, async (req, res) => {
  try {
    await recruitmentRepository.deleteEmailTemplate(req.params.id, cid(req));
    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== OFFERS ====================
router.get('/offers', view, async (req, res) => {
  try {
    const offers = await recruitmentRepository.findOffers({
      ...req.query, company_id: cid(req),
    });
    res.json(offers);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/offers/:id', view, async (req, res) => {
  try {
    const offer = await recruitmentRepository.findOfferById(req.params.id, cid(req));
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    res.json(offer);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/offers', add, validateBody(offerSchema), async (req, res) => {
  try {
    const offer = await recruitmentRepository.createOffer({
      ...req.body,
      company_id: cid(req),
      // Stamped server-side, never taken from the body: this is the value the
      // Approval Center compares against to block self-approval, so letting a
      // caller supply it would defeat the check it exists for.
      created_by: await employeeOf(req, pool),
    });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: offer.id, recordType: 'offer', action: 'create', newData: offer, req });
    res.status(201).json(offer);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/offers/:id', edit, validatePatch(offerSchema), async (req, res) => {
  try {
    // 'sent' is now gated through the Approval Center (POST
    // /approvals/offer:<id>/approve, which requires an approver role — see
    // approvals.controller.js's pendingOffers()/case 'offer'). Blocking it
    // here too, not just omitting a button in OfferManagement.jsx, so the
    // enforcement lives in the API and can't be bypassed by calling this
    // endpoint directly. Sending an offer is a real financial commitment,
    // same reasoning as requisition approval above.
    if (req.body.offer_status === 'sent') {
      return res.status(400).json({
        error: 'Offers must be sent through the Approval Center, not edited directly.',
      });
    }
    const offer = await recruitmentRepository.updateOffer(req.params.id, req.body, cid(req));
    res.json(offer);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/offers/:id/accept', edit, async (req, res) => {
  try {
    const offer = await recruitmentRepository.acceptOffer(req.params.id, cid(req));
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'offer', action: 'accept', newData: offer, req });

    // acceptOffer() always flips the candidate straight to Hired — same
    // auto-creation hook as the move-stage route above. See
    // AUTOMATION_OPPORTUNITY_AUDIT.md §10.1. Safe against double-invocation:
    // acceptOffer()'s status guard means a repeat call never reaches here, and
    // autoCreateEmployeeFromCandidate() de-dupes against its own creation log.
    recruitmentRepository.autoCreateEmployeeFromCandidate(
      offer.candidate_id, cid(req), req.user?.userId ?? req.user?.id ?? null
    ).catch(err => console.warn('[Recruitment] auto-create-on-hire failed:', err.message));

    res.json(offer);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== ANALYTICS ====================
router.get('/analytics/source', view, async (req, res) => {
  try {
    const analytics = await recruitmentRepository.getSourceAnalytics(cid(req));
    res.json(analytics);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/analytics/time-to-hire', view, async (req, res) => {
  try {
    const data = await recruitmentRepository.getTimeToHire(cid(req));
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/analytics/offer-acceptance-rate', view, async (req, res) => {
  try {
    const data = await recruitmentRepository.getOfferAcceptanceRate(cid(req));
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/analytics/interview-to-hire-ratio', view, async (req, res) => {
  try {
    const data = await recruitmentRepository.getInterviewToHireRatio(cid(req));
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== ONBOARDING ====================
// Read-only view of recently-hired candidates and how far their onboarding has
// actually got. Recruitment does NOT own onboarding — HR does, in
// hr_onboarding_checklist_templates/_progress, initialised by hireCandidate() and
// edited through /hr/onboarding/*. This endpoint only reports on that system so the
// recruiter who filled the role can see whether the handover landed; every mutation
// still belongs to HR's routes.
//
// (The page this used to back, OnboardingChecklist.jsx, was a hardcoded 25-item list
// persisted to localStorage and completely disconnected from the real tables. It was
// deleted rather than fixed. Progress counts below come from the real ones.)
router.get('/onboarding', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const params = [company_id];
    // `total` is the count of active checklist templates, matching how
    // GET /hr/onboarding/progress/:employee_id computes its denominator — progress
    // rows only exist for items someone has touched, so counting those instead
    // would report 3/3 complete for an employee with 3 done and 20 untouched.
    const query = `
      SELECT c.id, c.full_name AS name, c.email, c.phone,
             COALESCE(jo.job_title, jr.job_title) AS designation,
             COALESCE(jo.department, jr.department) AS department,
             TO_CHAR(c.hired_at::date, 'YYYY-MM-DD') AS joining_date,
             e.id AS employee_id,
             COALESCE(tpl.total, 0)::int AS onboarding_total,
             COALESCE(prog.done, 0)::int AS onboarding_done
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      -- The link Recruitment → Employees. NULL here means the hire never produced
      -- an employee record, i.e. auto-creation failed and is sitting in
      -- recruitment_employee_creation_log — worth surfacing, not hiding.
      LEFT JOIN employees e
             ON e.source_candidate_id = c.id AND e.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total
          FROM hr_onboarding_checklist_templates t
         WHERE t.is_active = true
           AND (t.company_id IS NULL OR t.company_id = $1)
      ) tpl ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE p.done) AS done
          FROM hr_onboarding_checklist_progress p
         WHERE p.employee_id = e.id
      ) prog ON TRUE
      WHERE c.overall_status = 'hired'
        AND c.hired_at >= NOW() - INTERVAL '60 days'
        AND c.deleted_at IS NULL
        AND ($1::int IS NULL OR c.company_id = $1)
      ORDER BY c.hired_at DESC`;
    const result = await pool.query(query, params);
    // pct is derived here rather than in SQL so the divide-by-zero case (no templates
    // configured) stays explicit. COUNT() comes back as a bigint → JS string, hence
    // the ::int casts above; without them `total > 0` is true for the string "0".
    res.json(result.rows.map(r => ({
      ...r,
      onboarding_pct: r.onboarding_total > 0
        ? Math.round((r.onboarding_done / r.onboarding_total) * 100)
        : null,
    })));
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== REPORTS ====================
router.get('/reports/summary', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date, department } = req.query;
    const data = await recruitmentRepository.getReportsSummary({ company_id, from_date, to_date, department });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/reports/vacancy-aging', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getVacancyAging({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/reports/source-effectiveness', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getSourceEffectiveness({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/reports/department-pipeline', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getDepartmentPipeline({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

// =============================================================================
// PHASE 51 — EMPLOYEE AUTO-CREATION (Hired → Employee Master)
// =============================================================================

// GET /recruitment/auto-creation/pending — candidates in Hired status without employee record
router.get('/auto-creation/pending', view, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.full_name, c.email, c.phone, c.current_stage, c.applied_job_id AS job_opening_id,
             jo.job_title, jo.department, jo.location,
             o.offered_salary, o.joining_date,
             ecl.status AS creation_status, ecl.employee_code, ecl.triggered_at, ecl.error_log
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        LEFT JOIN offer_letters o ON o.candidate_id = c.id AND LOWER(COALESCE(o.offer_status, o.offer_status, '')) = 'accepted'
        LEFT JOIN recruitment_employee_creation_log ecl ON ecl.candidate_id = c.id AND ecl.company_id = $1
       WHERE c.company_id = $1 AND LOWER(c.current_stage) = 'hired'
       ORDER BY o.joining_date ASC NULLS LAST, c.updated_at DESC
    `, [cid(req)]);
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    respondError(res, err);
  }
});

// POST /recruitment/auto-creation/:candidateId/trigger — create employee from hired candidate
// (manual fallback — the same logic now also fires automatically when a candidate
// reaches Hired via move-stage or offer-accept below, see recruitmentRepository
// .autoCreateEmployeeFromCandidate and AUTOMATION_OPPORTUNITY_AUDIT.md §10.1)
router.post('/auto-creation/:candidateId/trigger', add, async (req, res) => {
  try {
    const company_id = cid(req);
    const candidate_id = req.params.candidateId; // UUID — do NOT parseInt
    const triggered_by = req.user?.userId ?? req.user?.id ?? null;

    const result = await recruitmentRepository.autoCreateEmployeeFromCandidate(candidate_id, company_id, triggered_by);
    if (result.status !== 201) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.employee_code ? { employee_code: result.employee_code } : {}),
      });
    }

    notify(triggered_by, 'recruitment', candidate_id,
      `Employee ${result.employeeId} created for ${result.candidateName} — pending onboarding setup`);

    res.status(201).json({
      message: 'Employee created successfully',
      employee_id: result.employee.id,
      employee_code: result.employeeId,
      candidate_name: result.candidateName,
      next_steps: ['Configure payroll profile', 'Set up leave balance', 'Create email account', 'Add to org chart'],
    });
  } catch (err) { respondError(res, err); }
});

// GET /recruitment/auto-creation/log — creation history
router.get('/auto-creation/log', view, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ecl.*, c.email AS candidate_email
        FROM recruitment_employee_creation_log ecl
        LEFT JOIN candidates c ON c.id = ecl.candidate_id
       WHERE ecl.company_id = $1
       ORDER BY ecl.triggered_at DESC LIMIT 100
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { respondError(res, err); }
});

export default router;
