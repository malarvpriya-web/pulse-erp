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
import { changeLegalHold, LegalHoldError } from '../candidateLegalHold.js';
import { triggerEmail } from '../../../services/emailTrigger.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { createProposal, ProposalError } from '../../payroll/salaryProposals.service.js';
// Resolves the display name stored on each candidate_activity row. See
// modules/recruitment/actorName.js for why the name is denormalised.
import { actorNameOf } from '../actorName.js';
// The activity timeline (§21). Every event a recruiter needs to account for later
// is appended here as well as being applied, so the candidate's own page tells
// the whole story without the reader having to visit five other screens.
import candidateIntelligence from '../repositories/candidateIntelligence.repository.js';
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
import { parseResume } from '../../../services/resumeParser.service.js';
import {
  requisitionSchema, openingSchema, candidateSchema, moveStageSchema,
  interviewSchema, interviewNoteSchema, submitFeedbackSchema,
  offerSchema, emailTemplateSchema, recommendSchema, applicationStageSchema,
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
// Bulk export of candidate PII is a materially different act from reading one
// record on screen, and the permission matrix already distinguishes them —
// `can_export` is granted to 4 recruitment roles, not the 7 that hold view. It
// was never enforced anywhere; the Candidates page's CSV button simply called
// the list endpoint and built a file client-side, so anyone who could see the
// list could take a copy of it.
const exportPerm = requirePermission('recruitment', 'export');

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

// The UUID → INTEGER conversion of these tables' candidate_id / job_opening_id
// used to run here, unconditionally, on every import. Against an
// already-integer column it still took ACCESS EXCLUSIVE locks on
// interview_schedules and candidates, and deadlocked concurrent deletes of
// employees and companies (§223). It is now migration
// 20261103000001_recruitment_id_columns_integer, which alters a column only
// when its current type is not integer.

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

    // An open role is on the careers page the moment it exists — that is what
    // the public endpoint serves. Recording it here means the distribution
    // tracker is accurate for jobs created from now on, not just the ones the
    // migration backfilled; otherwise the checklist would show "Careers page:
    // draft" for a role that is already publicly advertised.
    if ((opening.status || '').toLowerCase() === 'open') {
      pool.query(
        `INSERT INTO job_distributions
           (company_id, job_opening_id, channel, status, posting_mode, posted_at, created_by)
         SELECT $1, $2, 'careers', 'posted', 'automatic', NOW(), $3
          WHERE EXISTS (SELECT 1 FROM careers_portals WHERE company_id = $1 AND is_active)
         ON CONFLICT (job_opening_id, channel) DO NOTHING`,
        [cid(req), opening.id, req.user?.userId ?? null]
      ).catch(err => console.warn('[Distribution] careers row failed:', err.message));
    }
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
// Filters: applied_job_id, current_stage, overall_status, source, search,
// location, experience_min/max, notice_period_max, expected_ctc_max, min_rating,
// skills (repeatable or comma-separated — ALL must match), sort_by, sort_dir,
// limit, offset. Everything but education, which has no column to filter on.
router.get('/candidates', view, async (req, res) => {
  try {
    const result = await recruitmentRepository.findCandidates({
      ...req.query,
      // `recruiter_id=me` is resolved HERE, not in the repository and not in the
      // browser. The browser does not reliably know its own users.id (the auth
      // store carries a role and an email), and letting the client send an id it
      // claims is its own would make "my candidates" a filter anyone could point
      // at anyone. 'unassigned' passes through untouched.
      recruiter_id: req.query.recruiter_id === 'me'
        ? (req.user?.userId ?? req.user?.id ?? null)
        : req.query.recruiter_id,
      // `?skills=a&skills=b` and `?skills=a,b` are both natural to write; the
      // repository normaliser accepts either, this just avoids it seeing a
      // single-element array of "a,b".
      skills: Array.isArray(req.query.skills)
        ? req.query.skills
        : (req.query.skills ? String(req.query.skills).split(',') : undefined),
      company_id: cid(req),
    });
    // The list is now paginated, so the count callers need is no longer
    // `response.length`. Header first (so a client reading the array still
    // works), envelope second.
    res.set('X-Total-Count', String(result.total));
    res.json(result);
  } catch (error) {
    respondError(res, error);
  }
});

// Declared BEFORE /candidates/:id. Express matches in registration order, so a
// literal path that comes after a :param route on the same prefix is
// unreachable — '/candidates/export' would be captured as id='export' and
// answer 'Candidate not found'. Same reason /filter-options sits where it does.
router.get('/candidates/export', exportPerm, async (req, res) => {
  try {
    const result = await recruitmentRepository.findCandidates({
      ...req.query,
      skills: Array.isArray(req.query.skills)
        ? req.query.skills
        : (req.query.skills ? String(req.query.skills).split(',') : undefined),
      company_id: cid(req),
      limit: 500,
    });
    const rows = result.rows.filter(r => !r.anonymised_at);

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment', recordId: null, recordType: 'candidate_export',
      action: 'export',
      newData: { rows: rows.length, filters: req.query },
      req,
    });
    await pool.query(
      `INSERT INTO candidate_retention_log (company_id, candidate_id, action, reason, triggered_by)
       VALUES ($1, NULL, 'exported', $2, $3)`,
      [cid(req), `${rows.length} candidates`, req.user?.userId ?? null]
    ).catch(() => {});

    res.json({ rows, total: rows.length, exported_at: new Date().toISOString() });
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

    // The first entry on the candidate's timeline. Awaited rather than
    // fire-and-forget: a swallowed history write that still answers 201 is how
    // this codebase lost ledger rows once already.
    await candidateIntelligence.recordActivity({
      company_id: cid(req),
      candidate_id: candidate.id,
      event_type: 'application_received',
      summary: candidate.job_title
        ? `Application received for ${candidate.job_title}`
        : 'Candidate profile created',
      detail: { source: candidate.source || null, has_resume: Boolean(req.file) },
      actor_user_id: req.user?.userId ?? req.user?.id ?? null,
      actor_name: await actorNameOf(req),
    });
    if (req.file) {
      await candidateIntelligence.recordActivity({
        company_id: cid(req),
        candidate_id: candidate.id,
        event_type: 'resume_uploaded',
        summary: `Résumé uploaded (${req.file.originalname})`,
        detail: { filename: req.file.originalname, mimetype: req.file.mimetype },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      });
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
    // `moved_by` is the employee FK (often absent); `moved_by_user_id` is the
    // acting login and is always known. Passing both means the history names
    // an actor even for accounts with no employee record.
    await recruitmentRepository.moveCandidateStage(
      req.params.id, new_stage,
      moved_by ?? req.user?.employee_id ?? null,
      notes, cid(req), null,
      req.user?.userId ?? req.user?.id ?? null,
      // The activity timeline stores the actor's NAME as well as their id, so a
      // move stays attributable after the account is gone. Resolved once per
      // request and cached for five minutes.
      { actor_name: await actorNameOf(req) },
    );

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

// ==================== CONSENT & RETENTION ====================
// See migration 20260917000037 and jobs/candidateRetention.cron.js.

/**
 * GET /recruitment/candidates/export — the server-side export.
 *
 * Exists so that taking a copy of the candidate database is an act the system
 * can (a) require a distinct permission for and (b) record. Both were missing:
 * the CSV button built the file in the browser from the ordinary list response,
 * so every holder of `recruitment:view` could export everything and nothing
 * anywhere showed that they had.
 *
 * Anonymised candidates are excluded — re-exporting a record that was erased on
 * request would undo the erasure.
 */
/**
 * POST /recruitment/candidates/:id/withdraw-consent
 *
 * A candidate asking to be removed. Recorded, not acted on immediately: the
 * nightly retention job anonymises withdrawn records, so the destructive step
 * runs in one place with one set of rules and one log, rather than being
 * duplicated behind a button.
 */
router.post('/candidates/:id/withdraw-consent', edit, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE candidates
          SET consent_withdrawn_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
        RETURNING id, company_id, full_name, consent_withdrawn_at`,
      [req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });

    await pool.query(
      `INSERT INTO candidate_retention_log (company_id, candidate_id, action, reason, triggered_by)
       VALUES ($1, $2, 'withdrawn', $3, $4)`,
      [rows[0].company_id, rows[0].id, String(req.body?.reason || 'requested by candidate').slice(0, 60),
       req.user?.userId ?? null]
    );
    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'candidate',
      action: 'withdraw_consent', newData: { reason: req.body?.reason || null }, req,
    });

    res.json({
      ...rows[0],
      message: 'Consent withdrawn. This record will be anonymised on the next retention run.',
    });
  } catch (error) {
    respondError(res, error);
  }
});

/**
 * Legal hold — POST (place) / PUT (amend reason) / DELETE (release)
 * /recruitment/candidates/:id/legal-hold, body { reason } (required, 5–500 chars).
 *
 * A held candidate is never anonymised by the retention job and nothing of theirs
 * is queued for file deletion, even after a consent withdrawal. Authority is
 * recruitment:APPROVE (admin, super_admin, hr_manager), deliberately stronger than
 * the `edit` that withdraw-consent / extend-retention use: recruiters, managers
 * and department heads hold `edit`. Own company only — a caller with no company
 * is refused, never treated as "every company". Logic and audit trail:
 * ../candidateLegalHold.js.
 */
const legalHold = (action) => async (req, res) => {
  try {
    const hold = await changeLegalHold({
      action, candidateId: req.params.id, companyId: cid(req),
      userId: req.user?.userId ?? req.user?.id ?? null, reason: req.body?.reason, req,
    });
    res.json(hold);
  } catch (error) {
    if (error instanceof LegalHoldError) return res.status(error.status).json({ error: error.message });
    respondError(res, error);
  }
};
const approveRecruitment = requirePermission('recruitment', 'approve');
router.post('/candidates/:id/legal-hold',   approveRecruitment, legalHold('place'));
router.put('/candidates/:id/legal-hold',    approveRecruitment, legalHold('amend'));
router.delete('/candidates/:id/legal-hold', approveRecruitment, legalHold('release'));

/** POST /recruitment/candidates/:id/extend-retention — keep a record longer. */
router.post('/candidates/:id/extend-retention', edit, async (req, res) => {
  try {
    const months = parseInt(req.body?.months, 10);
    if (!Number.isFinite(months) || months < 1 || months > 240) {
      return res.status(400).json({ error: 'Give a number of months between 1 and 240.' });
    }
    const { rows } = await pool.query(
      `UPDATE candidates
          SET retain_until = (CURRENT_DATE + ($3::int * INTERVAL '1 month'))::date,
              updated_at = NOW()
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
          AND anonymised_at IS NULL
        RETURNING id, company_id, retain_until`,
      [req.params.id, cid(req), months]
    );
    if (!rows.length) return res.status(404).json({ error: 'Candidate not found, or already anonymised.' });

    await pool.query(
      `INSERT INTO candidate_retention_log (company_id, candidate_id, action, reason, retain_until, triggered_by)
       VALUES ($1, $2, 'extended', $3, $4, $5)`,
      [rows[0].company_id, rows[0].id, `extended by ${months} months`, rows[0].retain_until,
       req.user?.userId ?? null]
    );
    res.json(rows[0]);
  } catch (error) {
    respondError(res, error);
  }
});

/**
 * GET /recruitment/privacy/summary — what the module is holding, and on what basis.
 *
 * The question a privacy review actually asks. `legacy` is called out
 * separately: those records predate consent capture and have no retention date,
 * so nothing will ever expire them. Somebody has to decide about them, and this
 * is where the number is visible.
 */
router.get('/privacy/summary', view, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows: [summary] } = await pool.query(
      `SELECT
         COUNT(*)::int                                                              AS total,
         COUNT(*) FILTER (WHERE consent_basis = 'consent')::int                     AS with_consent,
         COUNT(*) FILTER (WHERE consent_basis = 'legacy')::int                      AS legacy_no_consent,
         COUNT(*) FILTER (WHERE retain_until IS NOT NULL)::int                      AS with_retention_date,
         COUNT(*) FILTER (WHERE retain_until IS NOT NULL
                            AND retain_until < CURRENT_DATE
                            AND anonymised_at IS NULL
                            AND NOT legal_hold
                            AND COALESCE(overall_status,'') NOT IN ('active','hired'))::int AS due_for_purge,
         COUNT(*) FILTER (WHERE consent_withdrawn_at IS NOT NULL AND anonymised_at IS NULL)::int AS withdrawal_pending,
         -- Held records are never purged while the hold lasts (candidateLegalHold.js).
         COUNT(*) FILTER (WHERE legal_hold AND anonymised_at IS NULL)::int          AS on_legal_hold,
         COUNT(*) FILTER (WHERE anonymised_at IS NOT NULL)::int                     AS anonymised
       FROM candidates
       WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL`,
      [companyId]
    );
    const { rows: recent } = await pool.query(
      `SELECT action, reason, candidate_id, created_at
         FROM candidate_retention_log
        WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 50`,
      [companyId]
    );
    res.json({ summary, recent });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== RESUME PARSING ====================

/**
 * POST /recruitment/resume/parse — read a résumé, suggest the fields.
 *
 * This endpoint WRITES NOTHING. It returns extracted values and a per-field
 * confidence for a recruiter to review, correct and then submit through the
 * ordinary create-candidate route.
 *
 * That separation is the point. Parsing is a heuristic over somebody's PDF
 * layout: it is right most of the time and confidently wrong some of the time,
 * and a pipeline full of silently-mis-parsed candidates is worse than one
 * filled in by hand. Making the human press "create" keeps a person between the
 * guess and the record.
 *
 * Also returns `duplicate_of` when the parsed email is already in the pipeline,
 * so the recruiter finds out before filling in a form, not after submitting it.
 */
router.post('/resume/parse', add, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach a résumé to parse.' });

    const parsed = await parseResume(req.file.buffer, req.file.mimetype, req.file.originalname);

    let duplicate_of = null;
    if (parsed.fields.email) {
      const { rows } = await pool.query(
        `SELECT id, full_name, current_stage FROM candidates
          WHERE company_id = $1 AND LOWER(TRIM(email)) = LOWER(TRIM($2)) AND deleted_at IS NULL
          LIMIT 1`,
        [cid(req), parsed.fields.email]
      );
      if (rows.length) duplicate_of = rows[0];
    }

    res.json({
      fields: parsed.fields,
      confidence: parsed.confidence,
      warnings: parsed.warnings,
      duplicate_of,
      // Sent back so the create call can store it without re-uploading and
      // re-parsing the file. Truncated: the column is for search, not archival,
      // and a 40-page PDF in a JSON response helps nobody.
      resume_text: parsed.text.slice(0, 20000),
      parse_source: req.file.originalname,
    });
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    res.status(status).json({
      error: status === 415
        ? error.message
        : 'Could not read that file. It may be a scanned image or password-protected.',
    });
  }
});

// ==================== APPLICATIONS (candidate × opening) ====================

// Every opening this candidate is being considered for, each with its own stage.
router.get('/candidates/:id/applications', view, async (req, res) => {
  try {
    const rows = await recruitmentRepository.findCandidateApplications(req.params.id, cid(req));
    res.json(rows);
  } catch (error) {
    respondError(res, error);
  }
});

/**
 * POST /candidates/:id/recommend — put a candidate forward for other openings.
 *
 * The audit's most-requested missing capability, and the reason
 * candidate_applications exists: HR assesses someone for Electrical Engineer,
 * decides Service Engineer suits them better, and forwards them in one action.
 * The original application keeps its stage, its interviews and its history; no
 * second candidate profile is created; the two are tracked separately from here.
 */
router.post('/candidates/:id/recommend', add, validateBody(recommendSchema), async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.job_opening_ids)
      ? req.body.job_opening_ids
      : String(req.body.job_opening_ids || '').split(','))
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n > 0);

    if (!ids.length) {
      return res.status(400).json({ error: 'Select at least one job opening to recommend this candidate for.' });
    }

    const { candidate, created, alreadyThere } = await recruitmentRepository.recommendCandidateForJobs(
      req.params.id, ids,
      {
        company_id: cid(req),
        recommended_by: req.user?.userId ?? req.user?.id ?? null,
        notes: req.body.notes || null,
      }
    );

    // "Notify the relevant recruiter or hiring manager." The requisition's
    // requested_by is the person who asked for the role, so they are the one who
    // needs to know a candidate has been put forward for it.
    for (const app of created) {
      const { rows } = await pool.query(
        `SELECT u.id AS user_id
           FROM job_openings jo
           JOIN job_requisitions jr ON jr.id = jo.requisition_id
           JOIN users u ON u.employee_id = jr.requested_by
          WHERE jo.id = $1
          LIMIT 1`,
        [app.job_opening_id]
      ).catch(() => ({ rows: [] }));
      const target = rows[0]?.user_id ?? req.user?.userId ?? req.user?.id;
      notify(target, 'recruitment', candidate.id,
        `${candidate.full_name} has been recommended for ${app.job_title}`);
    }

    logAudit({
      userId: req.user?.userId ?? req.user?.id,
      module: 'Recruitment',
      recordId: parseInt(req.params.id),
      recordType: 'candidate',
      action: 'recommend',
      newData: { job_opening_ids: created.map(a => a.job_opening_id), notes: req.body.notes || null },
      req,
    });

    for (const app of created) {
      await candidateIntelligence.recordActivity({
        company_id: cid(req),
        candidate_id: candidate.id,
        application_id: app.id,
        event_type: 'recommended_for_role',
        summary: `Put forward for ${app.job_title}`,
        detail: {
          job_opening_id: app.job_opening_id,
          job_title: app.job_title,
          notes: req.body.notes || null,
        },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      });
    }

    res.status(created.length ? 201 : 200).json({
      candidate_id: candidate.id,
      candidate_name: candidate.full_name,
      created,
      already_applied: alreadyThere,
      message: created.length
        ? `${candidate.full_name} recommended for ${created.map(a => a.job_title).join(', ')}.`
        : 'Already under consideration for every opening selected — nothing to add.',
    });
  } catch (error) {
    respondError(res, error);
  }
});

// Move ONE application through its own pipeline. A secondary application's
// stage is independent of the candidate's headline stage; the primary one
// writes through to it. See the repository for why.
router.post('/applications/:id/move-stage', edit, validateBody(applicationStageSchema), async (req, res) => {
  try {
    const app = await recruitmentRepository.moveApplicationStage(req.params.id, req.body.stage, {
      company_id: cid(req),
      moved_by: req.user?.employee_id ?? null,
      moved_by_user_id: req.user?.userId ?? req.user?.id ?? null,
      notes: req.body.notes || null,
      actor_name: await actorNameOf(req),
    });
    res.json(app);
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
// Per-opening board. Counts and columns both read candidate_applications, so a
// candidate recommended onto this role appears here exactly like one who applied
// to it directly — which is the whole point of having the table.
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
    await candidateIntelligence.recordActivity({
      company_id: cid(req),
      candidate_id: interview.candidate_id,
      event_type: 'interview_scheduled',
      summary: `Interview scheduled for ${interview.interview_date}`
             + (interview.interview_time ? ` at ${String(interview.interview_time).slice(0, 5)}` : '')
             + (interview.interview_mode ? ` (${interview.interview_mode})` : ''),
      detail: {
        interview_id: interview.id, interview_date: interview.interview_date,
        interview_mode: interview.interview_mode || null,
        interviewer_id: interview.interviewer_id || null,
      },
      actor_user_id: req.user?.userId ?? req.user?.id ?? null,
      actor_name: await actorNameOf(req),
    });

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

    // Feedback is a one-shot action per scheduled interview. Without this, a
    // second submit against the SAME interview ran the whole handler again and
    // walked the candidate another stage — 1st_level → 2nd_level → offer off one
    // interview, auto-drafting an offer for a round that never happened. A
    // double-click was enough. Step 5 below already marks the row completed, so
    // this is the matching read side of that write.
    if (String(schedule.status || '').toLowerCase() === 'completed') {
      return res.status(409).json({
        error: 'Feedback has already been submitted for this interview. Schedule the next round to record another assessment.',
      });
    }
    if (String(schedule.status || '').toLowerCase() === 'cancelled') {
      return res.status(409).json({ error: 'This interview was cancelled — feedback cannot be recorded against it.' });
    }

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
    // interviewer_id is interview_notes' FK to employees(id). It used to be taken
    // unconditionally from the schedule, so the note recorded who was BOOKED to
    // interview rather than who actually filed the assessment — and nothing
    // checked that the submitter was that person. Prefer the submitter's own
    // employee id and fall back to the scheduled interviewer for callers with no
    // employee record (the admin accounts), so attribution is real where it can be.
    await pool.query(
      `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_round, rating, comments, recommendation)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [schedule.candidate_id, req.user?.employee_id ?? schedule.interviewer_id, interviewRound,
       rating ?? null, comments ?? null,
       outcome === 'selected' ? 'hire' : 'reject']
    );

    // This handler writes its note with a raw INSERT rather than through
    // createInterviewNote(), so it has to refresh the rollup itself — otherwise
    // candidates.overall_rating stays NULL for every candidate whose rating
    // arrived through the interview flow, which is most of them.
    await recruitmentRepository.refreshOverallRating(schedule.candidate_id);

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
        // getCandidateStageHistory's own read joins on employees. moved_by_user_id
        // (last argument) carries the login, which is what keeps the trail intact
        // when the submitter has no employee record.
        req.user?.employee_id ?? null,
        rejection_reason || `Interview outcome: ${outcome}`,
        company_id,
        null,
        req.user?.userId ?? req.user?.id ?? null,
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

    // The stage move above already appended its own stage_change event (see
    // moveCandidateStage). This records the FEEDBACK, which is a separate fact
    // and the one a recruiter goes looking for six months later.
    await candidateIntelligence.recordActivity({
      company_id,
      candidate_id: schedule.candidate_id,
      event_type: 'interview_feedback_added',
      summary: `Interview feedback: ${String(outcome).replace(/_/g, ' ')}`
             + (rating ? ` (${rating}/5)` : ''),
      detail: {
        interview_id: req.params.id, outcome, rating: rating ?? null,
        // The comments themselves stay in interview_notes. The timeline records
        // that feedback exists and what it concluded, not its full text.
        has_comments: Boolean(comments),
        rejection_reason: rejection_reason || null,
        next_stage: nextStage || null,
      },
      actor_user_id: req.user?.userId ?? req.user?.id ?? null,
      actor_name: await actorNameOf(req),
    });

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
    if (offer.candidate_id) {
      await candidateIntelligence.recordActivity({
        company_id: cid(req),
        candidate_id: offer.candidate_id,
        event_type: 'offer_drafted',
        summary: 'Offer drafted'
               + (offer.offered_salary ? ` at ${offer.offered_salary}` : '')
               + (offer.joining_date ? `, joining ${String(offer.joining_date).slice(0, 10)}` : ''),
        detail: { offer_id: offer.id, offer_status: offer.offer_status || null },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      });
    }
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

// POST /recruitment/offers/:id/salary-proposal — HR-reviewed conversion of an
// accepted offer's ANNUAL CTC into a DRAFT salary revision for the hired
// employee (PAYROLL_DATA_FLOW_AUDIT.md Part 4). Nothing is paid from it until
// an approver approves the proposal in Payroll → Salary Structure. One live
// proposal per offer (unique index); the offer, the employee and the structure
// must all belong to the caller's company; the effective date defaults to the
// joining date and may not fall in an approved payroll month.
router.post('/offers/:id/salary-proposal', edit, async (req, res) => {
  const company_id = cid(req);
  if (company_id == null) return res.status(400).json({ message: 'Company context required' });
  try {
    const { rows: [o] } = await pool.query(
      `SELECT id, candidate_id, offered_salary, offer_status, joining_date
         FROM offer_letters WHERE id::text = $1 AND company_id = $2 AND deleted_at IS NULL`, [String(req.params.id), company_id]);
    if (!o) return res.status(404).json({ message: 'Offer not found' });
    if (String(o.offer_status).toLowerCase() !== 'accepted') return res.status(409).json({ message: `Offer is "${o.offer_status}" — only an accepted offer can be converted` });
    if (!(Number(o.offered_salary) > 0)) return res.status(422).json({ message: 'The offer has no annual CTC' });
    const { rows: [emp] } = await pool.query(
      `SELECT id, joining_date FROM employees WHERE source_candidate_id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [o.candidate_id, company_id]);
    if (!emp) return res.status(409).json({ message: 'The candidate has not been hired yet — convert the offer after the employee record exists' });
    const day = (d) => (d == null ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10));
    const effective_from = req.body?.effective_from || day(o.joining_date) || day(emp.joining_date);
    if (!effective_from) return res.status(422).json({ message: 'No joining date on the offer or the employee — give effective_from' });
    const r = await createProposal({ company_id, employee_id: emp.id, structure_id: req.body?.structure_id ?? null, effective_from,
      annual_ctc: Number(o.offered_salary), source_type: 'offer', source_id: o.id, userId: req.user?.userId ?? null, req });
    res.status(201).json(r);
  } catch (e) {
    if (e instanceof ProposalError) return res.status(e.status).json({ message: e.message, ...e.extra });
    res.status(500).json({ message: e.message });
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

    if (offer.candidate_id) {
      await candidateIntelligence.recordActivity({
        company_id: cid(req),
        candidate_id: offer.candidate_id,
        event_type: 'offer_accepted',
        summary: 'Offer accepted — candidate joining',
        detail: { offer_id: offer.id, joining_date: offer.joining_date || null },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      });
    }

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
         -- "Pending" must mean pending. This returned EVERY hired candidate,
         -- including those whose employee record already exists, so the
         -- "Awaiting Creation" badge over-counted permanently and each
         -- already-created candidate kept a Create button that answers 409.
         -- employees.source_candidate_id is the same idempotency key
         -- hireCandidate() checks, so the two agree by construction.
         AND NOT EXISTS (
           SELECT 1 FROM employees e
            WHERE e.source_candidate_id = c.id
              AND ($1::int IS NULL OR e.company_id = $1)
              AND e.deleted_at IS NULL
         )
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
