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
import { createProposal, ProposalError, isCtcModeOn } from '../../payroll/salaryProposals.service.js';
import { resolveConfig } from '../../integrations/integrationConfig.js';
// Resolves the display name stored on each candidate_activity row. See
// modules/recruitment/actorName.js for why the name is denormalised.
import { actorNameOf } from '../actorName.js';
import { requisitionRaiserScope, scopeAllows, raiserRefusal, canApproveRequisition, recruitmentDeptScope, recruitmentDeptFilter, canManageRecruitmentSetup } from '../requisitionAccess.js';
import { recordDepartmentSql } from '../repositories/recruitment.repository.js';
import { buildOfferLetterPdf } from '../offerLetter.js';
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

const notify = (userId, module, recordId, message, type = 'info') => {
  if (!userId) return;
  notificationsRepository.create({
    user_id: userId,
    title: (message || 'Notification').slice(0, 100),
    message,
    module_name: module,
    reference_id: recordId,
    notification_type: type,
  }).catch(() => {});
};

const router = express.Router();

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

/** 2026-11-17 → "17 Nov 2026" (dates in candidate-facing text). */
function fmtLetterDate(d) {
  if (!d) return '';
  const iso = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const [y, m, day] = iso.split('-').map(Number);
  if (!y || !m || !day) return String(d);
  return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${y}`;
}

// ==================== INTERVIEW HELPERS ====================
const ROUND_LABELS = {
  '1st_level': '1st Level Interview',
  '2nd_level': '2nd Level Interview',
  technical:   'Technical Interview',
  hr:          'HR Interview',
  final:       'Final Interview',
  screening:   'Screening',
};

// The browser used to send 'offline'/'online', which the API vocabulary never
// had (audit 2026-11-17 B1): every in-person or online booking was rejected.
function normaliseInterviewMode(req, _res, next) {
  const MAP = { offline: 'in_person', 'in-person': 'in_person', online: 'video' };
  if (req.body && MAP[req.body.interview_mode]) req.body.interview_mode = MAP[req.body.interview_mode];
  next();
}

/** Error text when the interviewer or a panel member is not an active employee of this company. */
async function interviewersOutsideCompany(body, companyId) {
  const ids = [body.interviewer_id, ...(Array.isArray(body.panel_employee_ids) ? body.panel_employee_ids : [])]
    .map(x => parseInt(x, 10)).filter(Number.isInteger);
  if (!ids.length) return null;
  const { rows } = await pool.query(
    `SELECT id FROM employees WHERE id = ANY($1::int[]) AND company_id = $2 AND deleted_at IS NULL`, [ids, companyId]);
  return rows.length === new Set(ids).size ? null : 'Pick the interviewer and panel from your own employees.';
}

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
    // ?department= — the Dashboard filter bar (stage counts ignore the period).
    const rows = await recruitmentRepository.getPipelineSummary(cid(req), null, {
      department: dimension(req.query, 'department'),
    });
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

/** A step on the job's timeline, by the signed-in user. Never throws. */
const jobEvent = (req, data) => recruitmentRepository.recordJobEvent({
  company_id: cid(req), actor_user_id: req.user?.userId ?? req.user?.id ?? null, ...data,
});

// Field → words, for "Edited: positions, budget" on the timeline.
const FIELD_WORDS = {
  job_title: 'title', department: 'department', employment_type: 'employment type',
  number_of_positions: 'positions', job_description: 'description', description: 'description',
  skills_required: 'skills', location: 'location', priority: 'priority',
  experience_min: 'experience', experience_max: 'experience', salary_min: 'salary', salary_max: 'salary',
  hiring_reason: 'reason for hiring', replacing_employee_id: 'employee replaced', justification: 'justification',
  closing_date: 'closing date',
};
/** Names of the fields whose value really changed (blank == null; 5 == "5.00"). */
function changedFields(before, patch) {
  const norm = (v) => {
    if (v === '' || v == null) return '';
    if (v instanceof Date) return toDateText(v);
    const s = String(v).trim();
    return s !== '' && !Number.isNaN(Number(s)) ? String(Number(s)) : s;
  };
  const words = Object.keys(patch)
    .filter(k => FIELD_WORDS[k] && norm(patch[k]) !== norm(before[k]))
    .map(k => FIELD_WORDS[k]);
  return [...new Set(words)];
}

// What the signed-in user may do with requisitions — the page shows only the
// buttons the API will accept (requisitionAccess.js has the rules).
router.get('/requisitions/access', view, async (req, res) => {
  try {
    const scope = await requisitionRaiserScope(req);
    res.json({
      can_raise: scope.any || scope.departments.length > 0,
      any_department: scope.any,
      departments: scope.departments,
      can_approve: canApproveRequisition(req),
    });
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/requisitions/:id/timeline', view, async (req, res) => {
  try {
    const requisition = await recruitmentRepository.findRequisitionById(req.params.id, cid(req));
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    res.json(await recruitmentRepository.getRequisitionTimeline(requisition.id, cid(req)));
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

/** min ≤ max for a pair of optional numbers; returns an error sentence or null. */
function rangeError(min, max, what) {
  const a = min === '' || min == null ? null : Number(min);
  const b = max === '' || max == null ? null : Number(max);
  return a != null && b != null && a > b ? `Minimum ${what} is more than the maximum.` : null;
}

/** YYYY-MM-DD in the business time zone (process TZ is pinned, see timezone.js). */
function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** A DATE value (pg returns a local-midnight Date) or 'YYYY-MM-DD…' → 'YYYY-MM-DD' / ''. */
function toDateText(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}
function closingDateError(v) {
  const d = toDateText(v);
  return d && d < todayText() ? 'The closing date cannot be in the past.' : null;
}

/**
 * An opening spends what its requisition approved: no more seats, no higher
 * pay, no wider experience band than the approver saw.
 */
function openingAgainstRequisitionError(o, r) {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const approved = n(r.number_of_positions);
  if (approved != null && n(o.number_of_positions) != null && n(o.number_of_positions) > approved) {
    return `The requisition approved ${approved} position${approved === 1 ? '' : 's'}. Raise another requisition for more.`;
  }
  if (n(r.salary_max) != null && n(o.salary_max) != null && n(o.salary_max) > n(r.salary_max)) {
    return `The salary goes above the approved budget (up to ₹${Number(r.salary_max).toLocaleString('en-IN')} per year).`;
  }
  if (n(r.salary_max) != null && n(o.salary_min) != null && n(o.salary_min) > n(r.salary_max)) {
    return `The salary goes above the approved budget (up to ₹${Number(r.salary_max).toLocaleString('en-IN')} per year).`;
  }
  return rangeError(o.experience_min, o.experience_max, 'experience')
      || rangeError(o.salary_min, o.salary_max, 'salary');
}

/**
 * An open role is on the careers page the moment it is open — that is what the
 * public endpoint serves — so the distribution tracker records it then: on
 * create, and when a draft is published or a closed job reopened.
 */
function recordCareersPosting(companyId, openingId, userId) {
  pool.query(
    `INSERT INTO job_distributions
       (company_id, job_opening_id, channel, status, posting_mode, posted_at, created_by)
     SELECT $1, $2, 'careers', 'posted', 'automatic', NOW(), $3
      WHERE EXISTS (SELECT 1 FROM careers_portals WHERE company_id = $1 AND is_active)
     ON CONFLICT (job_opening_id, channel) DO NOTHING`,
    [companyId, openingId, userId]
  ).catch(err => console.warn('[Distribution] careers row failed:', err.message));
}

/** Checks a requisition's content as it will be after the change. */
function requisitionContentError(r) {
  const e = rangeError(r.experience_min, r.experience_max, 'experience')
         || rangeError(r.salary_min, r.salary_max, 'salary');
  if (e) return e;
  if (r.hiring_reason === 'replacement' && !r.replacing_employee_id) {
    return 'Choose the employee this hire replaces.';
  }
  return null;
}

router.post('/requisitions', add, validateBody(requisitionSchema), async (req, res) => {
  try {
    // Raised by HR (any department) or a department head (their own).
    const scope = await requisitionRaiserScope(req);
    const dept = req.body.department ?? req.body.department_id;
    if (!scopeAllows(scope, dept)) return res.status(403).json({ error: raiserRefusal(scope, dept) });
    const problem = requisitionContentError(req.body);
    if (problem) return res.status(400).json({ error: problem });
    // requested_by is the signed-in user's employee. It was never written
    // (the body field was ignored and the repository read a key nobody sent),
    // so every requisition had requested_by NULL — "Requested by" showed "-"
    // and the Approval Center's self-approval block never fired.
    const { requested_by: _ignored, ...body } = req.body;
    const requisition = await recruitmentRepository.createRequisition({
      ...body, company_id: cid(req), requested_by_employee_id: await employeeOf(req, pool),
    });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: requisition.id, recordType: 'requisition', action: 'create', newData: requisition, req });
    await jobEvent(req, { requisition_id: requisition.id, event: 'raised', to_status: 'draft' });
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
    const current = await recruitmentRepository.findRequisitionById(req.params.id, cid(req));
    if (!current) return res.status(404).json({ error: 'Requisition not found' });
    // Managed by the same people who may raise it: HR, or the head of its
    // department (and of the new department, if a draft is moved).
    {
      const scope = await requisitionRaiserScope(req);
      // Super Admin (the approver) may also close, reopen, cancel or restore —
      // a status move only; raising, editing and submitting stay with HR and
      // department heads.
      const onlyStatus = Object.keys(req.body).every(k => k === 'status');
      const STATUS_MOVES = { open: ['closed'], closed: ['open'], draft: ['cancelled'], pending_approval: ['cancelled'], approved: ['cancelled'], cancelled: ['draft'] };
      const managementMove = canApproveRequisition(req) && onlyStatus
        && (STATUS_MOVES[current.status] || []).includes(req.body.status);
      if (!managementMove && !scopeAllows(scope, current.department)) return res.status(403).json({ error: raiserRefusal(scope, current.department) });
      const newDept = req.body.department ?? req.body.department_id;
      if (newDept !== undefined && !scopeAllows(scope, newDept)) return res.status(403).json({ error: raiserRefusal(scope, newDept) });
    }
    // Content (title, head count, budget...) is what the approver approved, so it
    // can only change while the requisition is still a draft, including one an
    // approver sent back. After that, only the status moves.
    const CONTENT = ['job_title', 'department', 'department_id', 'employment_type', 'number_of_positions',
      'job_description', 'skills_required', 'location', 'priority',
      'experience_min', 'experience_max', 'salary_min', 'salary_max',
      'hiring_reason', 'replacing_employee_id', 'justification'];
    const editsContent = CONTENT.some(k => req.body[k] !== undefined);
    if (editsContent && current.status !== 'draft') {
      return res.status(409).json({
        error: `This requisition is "${current.status.replace(/_/g, ' ')}" — only a draft can be edited. Cancel it and raise a new one if the need has changed.`,
      });
    }
    // Status moves allowed from the requisition screen. Approval and the open
    // step (creating the opening) happen elsewhere.
    if (req.body.status !== undefined && req.body.status !== current.status) {
      const ALLOWED = {
        draft:            ['pending_approval', 'cancelled'],
        pending_approval: ['draft', 'cancelled'],
        approved:         ['cancelled'],
        open:             ['closed'],
        // Reopen: the job comes back with it (see below).
        closed:           ['open'],
        // Restore a cancelled request; it must be approved again.
        cancelled:        ['draft'],
      };
      if (!(ALLOWED[current.status] || []).includes(req.body.status)) {
        return res.status(409).json({
          error: `A requisition cannot move from "${current.status.replace(/_/g, ' ')}" to "${String(req.body.status).replace(/_/g, ' ')}".`,
        });
      }
    }
    // Reopening a closed requisition reopens its job opening. If that job was
    // cancelled (a draft that was never published), the requisition goes back to
    // "approved" so a job can be posted against it again.
    let reopenJob = null;
    if (current.status === 'closed' && req.body.status === 'open') {
      if (current.opening_id && current.opening_status !== 'cancelled') {
        const job = await recruitmentRepository.findOpeningById(current.opening_id, cid(req));
        const total = Number(job?.number_of_positions || 1);
        if (Number(job?.positions_filled || 0) >= total) {
          return res.status(409).json({ error: `All ${total} position${total === 1 ? ' is' : 's are'} filled, so there is nothing to reopen. Raise a new requisition for more hires.` });
        }
        const closing = toDateText(job?.closing_date);
        if (closing && closing < todayText()) {
          return res.status(409).json({ error: 'The job\'s closing date has passed. Open the job under Job Openings, set a new closing date, then reopen.' });
        }
        reopenJob = job;
      } else {
        req.body.status = 'approved';
      }
    }
    const { requested_by: _ignored, ...body } = req.body;
    if (body.department === undefined && body.department_id !== undefined) body.department = body.department_id;
    delete body.department_id;
    const after = { ...current, ...body };
    const problem = requisitionContentError(after);
    if (problem) return res.status(400).json({ error: problem });
    // An approver decides on the reason, so it has to be there before it is sent.
    if (body.status === 'pending_approval' && !String(after.justification || '').trim()) {
      return res.status(400).json({ error: 'Add a justification (why this hire is needed) before submitting for approval.' });
    }
    if (body.status === 'pending_approval' && !String(after.department || '').trim()) {
      return res.status(400).json({ error: 'Choose the department before submitting for approval.' });
    }
    const requisition = await recruitmentRepository.updateRequisition(req.params.id, body, cid(req));
    // Closing the requisition closes the job it became: the headcount is no
    // longer authorised, so the advert must come down too.
    if (body.status === 'closed' && current.status === 'open') {
      await pool.query(
        `UPDATE job_openings SET status = 'closed', updated_at = NOW()
          WHERE requisition_id = $1 AND company_id = $2 AND deleted_at IS NULL AND status IN ('open', 'on_hold', 'draft')`,
        [current.id, cid(req)]);
    }
    if (reopenJob) {
      await pool.query(`UPDATE job_openings SET status = 'open', updated_at = NOW() WHERE id = $1 AND company_id = $2`, [reopenJob.id, cid(req)]);
      recordCareersPosting(cid(req), reopenJob.id, req.user?.userId ?? null);
    }
    const edited = changedFields(current, body);
    if (edited.length) {
      await jobEvent(req, { requisition_id: current.id, event: 'edited', comment: `Changed: ${edited.join(', ')}` });
    }
    if (body.status !== undefined && body.status !== current.status) {
      const reopened = current.status === 'closed';
      const event = reopened ? 'reopened'
        : current.status === 'cancelled' ? 'restored'
        : body.status === 'draft' ? 'withdrawn'
        : ({ pending_approval: 'submitted', cancelled: 'cancelled', closed: 'closed' }[body.status] || 'status');
      const comment = event === 'closed' && current.opening_id ? 'Its job opening was closed too.'
        : reopened && reopenJob ? 'Its job opening reopened too and is back on the careers page.'
        : reopened ? 'Back to approved — post a new job opening against it.'
        : event === 'restored' ? 'Back to draft — it must be submitted and approved again.' : null;
      await jobEvent(req, {
        requisition_id: current.id, job_opening_id: current.opening_id || null, event,
        from_status: current.status, to_status: body.status, comment,
      });
    }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: requisition.id, recordType: 'requisition', action: 'update', oldData: current, newData: requisition, req });
    res.json(requisition);
  } catch (error) {
    respondError(res, error);
  }
});

router.delete('/requisitions/:id', remove, async (req, res) => {
  try {
    const current = await recruitmentRepository.findRequisitionById(req.params.id, cid(req));
    if (!current) return res.status(404).json({ error: 'Requisition not found' });
    const scope = await requisitionRaiserScope(req);
    if (!scopeAllows(scope, current.department)) return res.status(403).json({ error: raiserRefusal(scope, current.department) });
    if (!['draft', 'cancelled'].includes(current.status)) {
      return res.status(409).json({ error: 'Only a draft or cancelled requisition can be deleted. Cancel it first.' });
    }
    await recruitmentRepository.deleteRequisition(req.params.id, cid(req));
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: current.id, recordType: 'requisition', action: 'delete', oldData: current, req });
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
    // An opening is the spend a requisition approved. Without this the approval
    // step could be skipped entirely (audit 2026-11-17 B6): every opening on the
    // database had been created with no requisition at all.
    if (!req.body.requisition_id) {
      return res.status(400).json({
        error: 'Choose the approved requisition this opening is for. Raise a requisition under Jobs → Requisitions and have it approved first.',
      });
    }
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
    const requisition = await recruitmentRepository.findRequisitionById(req.body.requisition_id, cid(req));
    if (!requisition) return res.status(404).json({ error: 'Requisition not found.' });
    const status = req.body.status || 'open';
    if (!['open', 'draft'].includes(status)) {
      return res.status(400).json({ error: 'A new job opening is either published (open) or saved as a draft.' });
    }
    const body = { ...req.body, status,
      // The department and type are what was approved; the opening follows them.
      department: requisition.department || req.body.department,
      employment_type: requisition.employment_type || req.body.employment_type };
    const problem = openingAgainstRequisitionError(body, requisition)
                 || closingDateError(body.closing_date);
    if (problem) return res.status(400).json({ error: problem });
    const opening = await recruitmentRepository.createOpening({
      ...body, company_id: cid(req),
    });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: opening.id, recordType: 'job_opening', action: 'create', newData: opening, req });
    await jobEvent(req, {
      requisition_id: requisition.id, job_opening_id: opening.id,
      event: opening.status === 'draft' ? 'job_drafted' : 'job_posted', to_status: opening.status,
      comment: opening.job_title !== requisition.job_title ? `Advertised as "${opening.job_title}"` : null,
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
      recordCareersPosting(cid(req), opening.id, req.user?.userId ?? null);
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
    const current = await recruitmentRepository.findOpeningById(req.params.id, cid(req));
    if (!current) return res.status(404).json({ error: 'Opening not found' });
    // The requisition an opening was raised against is fixed: moving it to
    // another would free one approval and consume a second without either
    // being recorded.
    if (req.body.requisition_id !== undefined
        && String(req.body.requisition_id || '') !== String(current.requisition_id || '')) {
      return res.status(400).json({ error: 'The requisition of a job opening cannot be changed. Close this one and post a new job against the other requisition.' });
    }
    const { requisition_id: _r, positions_filled: _pf, ...body } = req.body;
    const requisition = current.requisition_id
      ? await recruitmentRepository.findRequisitionById(current.requisition_id, cid(req)) : null;
    if (requisition) {
      // Department and type are what was approved.
      if (body.department !== undefined && requisition.department && body.department !== requisition.department) {
        return res.status(400).json({ error: `This job was approved for ${requisition.department}. Raise a new requisition to hire for another department.` });
      }
      if (body.employment_type !== undefined && requisition.employment_type && body.employment_type !== requisition.employment_type) {
        return res.status(400).json({ error: 'The employment type was set by the approved requisition and cannot be changed here.' });
      }
    }
    const after = { ...current, ...body };
    const problem = (requisition && openingAgainstRequisitionError(after, requisition))
                 || rangeError(after.experience_min, after.experience_max, 'experience')
                 || rangeError(after.salary_min, after.salary_max, 'salary')
                 || (body.closing_date !== undefined && String(body.closing_date || '').slice(0, 10) !== toDateText(current.closing_date)
                       ? closingDateError(body.closing_date) : null);
    if (problem) return res.status(400).json({ error: problem });
    if (body.number_of_positions != null && body.number_of_positions !== ''
        && Number(body.number_of_positions) < Number(current.positions_filled || 0)) {
      return res.status(400).json({ error: `${current.positions_filled} position(s) are already filled — the head count cannot go below that.` });
    }

    // Status moves.
    const from = current.status;
    const to = body.status;
    if (to !== undefined && to !== from) {
      const ALLOWED = {
        draft:   ['open', 'cancelled'],
        open:    ['on_hold', 'closed'],
        on_hold: ['open', 'closed'],
        paused:  ['open', 'closed'],
        closed:  ['open'],
      };
      if (!(ALLOWED[from] || []).includes(to)) {
        return res.status(409).json({ error: `A job opening cannot move from "${String(from).replace(/_/g, ' ')}" to "${String(to).replace(/_/g, ' ')}".` });
      }
      if (to === 'open') {
        const total = Number(after.number_of_positions || 1);
        if (Number(current.positions_filled || 0) >= total) {
          return res.status(409).json({ error: 'Every position on this job is filled. Raise a new requisition for more hires.' });
        }
        const closing = toDateText(after.closing_date);
        if (closing && closing < todayText()) {
          return res.status(400).json({ error: 'The closing date has passed. Set a new closing date before reopening this job.' });
        }
      }
    }

    const opening = await recruitmentRepository.updateOpening(req.params.id, body, cid(req));

    if (to !== undefined && to !== from) {
      if (to === 'open') {
        if (!opening.posted_date) {
          await pool.query(`UPDATE job_openings SET posted_date = CURRENT_DATE WHERE id = $1`, [opening.id]);
        }
        recordCareersPosting(cid(req), opening.id, req.user?.userId ?? null);
      }
      // The requisition follows its job: closed with it, reopened with it.
      if (current.requisition_id) {
        if (['closed', 'cancelled'].includes(to)) {
          await pool.query(`UPDATE job_requisitions SET status = 'closed', updated_at = NOW() WHERE id = $1 AND status = 'open'`, [current.requisition_id]);
        } else if (to === 'open' && from === 'closed') {
          await pool.query(`UPDATE job_requisitions SET status = 'open', updated_at = NOW() WHERE id = $1 AND status = 'closed'`, [current.requisition_id]);
        }
      }
    }
    if (current.requisition_id) {
      const edited = changedFields(current, body);
      if (edited.length) {
        await jobEvent(req, { requisition_id: current.requisition_id, job_opening_id: opening.id, event: 'job_edited', comment: `Changed: ${edited.join(', ')}` });
      }
      if (to !== undefined && to !== from) {
        const STEP = { on_hold: 'job_paused', closed: 'job_closed', cancelled: 'job_cancelled' };
        const event = to === 'open' ? (from === 'draft' ? 'job_published' : 'job_reopened') : STEP[to] || 'job_status';
        const req_note = ['closed', 'cancelled'].includes(to) ? 'The requisition closed with it.'
                       : to === 'open' && from === 'closed' ? 'The requisition reopened with it.' : null;
        await jobEvent(req, { requisition_id: current.requisition_id, job_opening_id: opening.id, event, from_status: from, to_status: to, comment: req_note });
      }
    }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: opening.id, recordType: 'job_opening', action: 'update', oldData: current, newData: opening, req });
    res.json(await recruitmentRepository.findOpeningById(opening.id, cid(req)));
  } catch (error) {
    respondError(res, error);
  }
});

// Deleting is for a posting made by mistake. Once anyone has applied, close it
// instead: the applications and their history belong to that opening.
router.delete('/openings/:id', remove, async (req, res) => {
  try {
    const opening = await recruitmentRepository.findOpeningById(req.params.id, cid(req));
    if (!opening) return res.status(404).json({ error: 'Opening not found' });
    const { rows: [{ n }] } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM candidate_applications WHERE job_opening_id = $1)
            + (SELECT COUNT(*) FROM candidates WHERE applied_job_id = $1 AND deleted_at IS NULL) AS n`,
      [opening.id]);
    if (Number(n) > 0) {
      return res.status(409).json({ error: 'Candidates have applied to this opening — close it instead of deleting it.' });
    }
    await pool.query(`UPDATE job_openings SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND company_id = $2`, [opening.id, cid(req)]);
    // The requisition it consumed becomes available again.
    if (opening.requisition_id) {
      await pool.query(`UPDATE job_requisitions SET status = 'approved', updated_at = NOW() WHERE id = $1 AND status = 'open'`, [opening.requisition_id]);
      await jobEvent(req, { requisition_id: opening.requisition_id, event: 'job_deleted',
        comment: `"${opening.job_title}" was deleted. The requisition is approved and can be posted again.` });
    }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: opening.id, recordType: 'job_opening', action: 'delete', oldData: opening, req });
    res.json({ message: 'Opening deleted' });
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
    const before = await recruitmentRepository.findCandidateById(req.params.id, cid(req));
    if (!before) return res.status(404).json({ error: 'Candidate not found' });
    const body = { ...req.body };
    // Stage and status change only through move-stage, which writes the stage
    // history and the timeline. The résumé changes through POST …/resume.
    for (const k of ['current_stage', 'overall_status', 'company_id', 'candidate_code', 'resume_file_url',
                     'disposition', 'anonymised_at', 'legal_hold', 'consent_basis', 'retain_until']) delete body[k];
    // A blank field clears the value (the old Résumé Database edit used COALESCE,
    // so nothing could ever be removed once entered).
    for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
    if (body.full_name === null) return res.status(400).json({ error: 'Name cannot be empty.' });
    const candidate = await recruitmentRepository.updateCandidate(req.params.id, body, cid(req));
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: candidate.id, recordType: 'candidate', action: 'update', oldData: before, newData: candidate, req });
    const changed = Object.keys(body).filter(k => String(before[k] ?? '') !== String(candidate[k] ?? ''));
    if (changed.length) {
      await candidateIntelligence.recordActivity({
        company_id: cid(req), candidate_id: candidate.id, event_type: 'profile_updated',
        summary: `Profile updated: ${changed.map(k => k.replace(/_/g, ' ')).join(', ')}`,
        detail: { fields: changed },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null, actor_name: await actorNameOf(req),
      }).catch(() => {});
    }
    res.json(candidate);
  } catch (error) {
    respondError(res, error);
  }
});

// Replace the résumé on an existing candidate (Candidate Detail → Edit).
router.post('/candidates/:id/resume', edit, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach a PDF or Word résumé.' });
    const before = await recruitmentRepository.findCandidateById(req.params.id, cid(req));
    if (!before) return res.status(404).json({ error: 'Candidate not found' });
    const url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    // Re-read the text so résumé search finds the new content.
    let text = null;
    try { text = (await parseResume(req.file.buffer, req.file.mimetype, req.file.originalname))?.text || null; } catch { text = null; }
    const { rows: [c] } = await pool.query(
      `UPDATE candidates SET resume_file_url = $1, resume_text = COALESCE($2, resume_text), parsed_at = NOW(), updated_at = NOW()
        WHERE id = $3 AND company_id = $4 RETURNING *`,
      [url, text, before.id, cid(req)]);
    if (c.applied_job_id) {
      uploadResume(c.id, c.applied_job_id, req.file.buffer, req.file.originalname, req.file.mimetype)
        .catch(err => console.warn('[Drive] uploadResume failed:', err.message));
    }
    await candidateIntelligence.recordActivity({
      company_id: cid(req), candidate_id: c.id, event_type: 'resume_replaced',
      summary: `Résumé replaced (${req.file.originalname})`,
      actor_user_id: req.user?.userId ?? req.user?.id ?? null, actor_name: await actorNameOf(req),
    }).catch(() => {});
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: c.id, recordType: 'candidate', action: 'resume_replace', oldData: { resume_file_url: before.resume_file_url }, newData: { resume_file_url: url }, req });
    res.json(c);
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

    const { candidate, created, alreadyThere, broughtBack } = await recruitmentRepository.recommendCandidateForJobs(
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
      brought_back: Boolean(broughtBack),
      message: created.length
        ? (broughtBack
            ? `${candidate.full_name} is back in hiring for ${created.map(a => a.job_title).join(', ')}.`
            : `${candidate.full_name} recommended for ${created.map(a => a.job_title).join(', ')}.`)
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

// POST /candidates/:id/hire was removed 2026-11-17: no screen called it, and it
// duplicated autoCreateEmployeeFromCandidate() (accepting an offer, or Offer &
// Onboarding → Employee Creation), which is the one hiring path.

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
    const body = { ...req.body };
    // Feedback is attributed to the person filing it unless a recruiter is
    // recording it on someone's behalf.
    if (!body.interviewer_id) body.interviewer_id = await employeeOf(req, pool);
    if (body.interview_id) {
      const { rows } = await pool.query(
        `SELECT candidate_id, interview_round FROM interview_schedules WHERE id::text = $1 AND company_id = $2`,
        [String(body.interview_id), cid(req)]);
      if (!rows.length) return res.status(404).json({ error: 'Interview not found' });
      if (String(rows[0].candidate_id) !== String(body.candidate_id)) {
        return res.status(400).json({ error: 'That interview belongs to a different candidate.' });
      }
      if (!body.interview_round) body.interview_round = ROUND_LABELS[rows[0].interview_round] || rows[0].interview_round;
    }
    const note = await recruitmentRepository.createInterviewNote(body, cid(req));
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
    const filters = { ...req.query, company_id: cid(req) };
    delete filters.panel_member_id;
    // ?mine=1 → interviews where the caller is the lead interviewer or on the panel.
    if (String(req.query.mine) === '1') {
      const me = await employeeOf(req, pool);
      if (!me) return res.json([]);
      filters.panel_member_id = me;
    }
    const interviews = await recruitmentRepository.findInterviews(filters);
    res.json(interviews);
  } catch (error) {
    respondError(res, error);
  }
});

router.post('/interviews', add, normaliseInterviewMode, validateBody(interviewSchema), async (req, res) => {
  try {
    const company_id = cid(req);
    const cand = (await pool.query(
      `SELECT id, current_stage, applied_job_id FROM candidates WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [req.body.candidate_id, company_id])).rows[0];
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    const bad = await interviewersOutsideCompany(req.body, company_id);
    if (bad) return res.status(400).json({ error: bad });

    const interview = await recruitmentRepository.scheduleInterview({
      ...req.body, company_id, job_opening_id: req.body.job_opening_id || cand.applied_job_id || null,
    });

    // Booking a 1st/2nd level round moves a candidate who is still earlier in the
    // pipeline to that stage, so the board shows where they really are. Never
    // backwards, never out of a parked stage.
    const ORDER = ['applied', 'screening', 'shortlisted', 'assessment', '1st_level', '2nd_level'];
    const target = ['1st_level', '2nd_level'].includes(interview.interview_round) ? interview.interview_round : null;
    if (target && ORDER.includes(cand.current_stage) && ORDER.indexOf(cand.current_stage) < ORDER.indexOf(target)) {
      await recruitmentRepository.moveCandidateStage(cand.id, target, await employeeOf(req, pool),
        `${ROUND_LABELS[target]} scheduled for ${String(interview.interview_date).slice(0, 10)}`,
        company_id, null, req.user?.userId ?? req.user?.id ?? null);
    }

    // Notify the lead interviewer and every panel member.
    const panelIds = [interview.interviewer_id, ...(interview.panel_employee_ids || [])].filter(Boolean);
    if (panelIds.length) {
      const { rows: users } = await pool.query(
        'SELECT id AS user_id FROM users WHERE employee_id = ANY($1::int[]) AND is_active IS NOT FALSE', [panelIds]).catch(() => ({ rows: [] }));
      for (const u of users) {
        notify(u.user_id, 'recruitment', interview.candidate_id,
          `Interview with ${interview.candidate_name || 'a candidate'} on ${String(interview.interview_date).slice(0, 10)}`
          + (interview.interview_time ? ` at ${String(interview.interview_time).slice(0, 5)}` : '') + ' — see My Interviews',
          'interview_assigned');
      }
    }
    triggerEmail('interview_l1_scheduled', {
      candidate_email:  interview.candidate_email || '',
      candidate_name:   interview.candidate_name  || '',
      interview_date:   fmtLetterDate(interview.interview_date)
                        + (interview.interview_time ? ` at ${String(interview.interview_time).slice(0, 5)}` : ''),
      interview_mode:   ({ in_person: 'In person', video: 'Video call', phone: 'Phone' })[interview.interview_mode] || '',
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

router.put('/interviews/:id', edit, normaliseInterviewMode, validatePatch(interviewSchema), async (req, res) => {
  try {
    const company_id = cid(req);
    const before = (await pool.query(
      `SELECT * FROM interview_schedules WHERE id::text = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [String(req.params.id), company_id])).rows[0];
    if (!before) return res.status(404).json({ error: 'Interview not found' });
    const body = { ...req.body };
    delete body.candidate_id; // an interview never moves to another candidate
    const onlyQuestions = Object.keys(body).every(k => k === 'question_ids');
    if (before.status !== 'scheduled' && !onlyQuestions) {
      return res.status(409).json({ error: `This interview is ${before.status} — it can no longer be changed.` });
    }
    if (body.status === 'completed') {
      return res.status(400).json({ error: 'Record the outcome with "Complete" — that saves the feedback and moves the candidate.' });
    }
    const bad = await interviewersOutsideCompany({ ...body, interviewer_id: body.interviewer_id ?? null }, company_id);
    if (bad) return res.status(400).json({ error: bad });
    if (body.panel_employee_ids !== undefined && body.interviewer_id === undefined) body.interviewer_id = before.interviewer_id;

    const interview = await recruitmentRepository.updateInterview(req.params.id, body, company_id);
    const day = (d) => (d instanceof Date ? d.toISOString() : String(d ?? '')).slice(0, 10);
    const moved = (body.interview_date && day(body.interview_date) !== day(before.interview_date))
               || (body.interview_time && String(body.interview_time).slice(0, 5) !== String(before.interview_time ?? '').slice(0, 5));
    const what = body.status === 'cancelled' ? 'cancelled' : moved ? 'rescheduled' : null;
    if (what) {
      await candidateIntelligence.recordActivity({
        company_id, candidate_id: interview.candidate_id,
        event_type: what === 'cancelled' ? 'interview_cancelled' : 'interview_rescheduled',
        summary: what === 'cancelled'
          ? `Interview on ${day(before.interview_date)} cancelled`
          : `Interview moved from ${day(before.interview_date)} to ${day(interview.interview_date)}`
            + (interview.interview_time ? ` at ${String(interview.interview_time).slice(0, 5)}` : ''),
        detail: { interview_id: interview.id, reason: body.notes || null },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      }).catch(() => {});
      const panelIds = [interview.interviewer_id, ...(interview.panel_employee_ids || [])].filter(Boolean);
      if (panelIds.length) {
        const { rows: users } = await pool.query(
          'SELECT id AS user_id FROM users WHERE employee_id = ANY($1::int[])', [panelIds]).catch(() => ({ rows: [] }));
        for (const u of users) notify(u.user_id, 'recruitment', interview.candidate_id, `An interview you are on was ${what}`, 'interview_changed');
      }
    }
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: null, recordType: 'interview', action: what || 'update', oldData: before, newData: interview, req });
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
    // The round booked on the interview wins; older interviews fall back to the
    // candidate's stage, which is how the round used to be guessed.
    const round = schedule.interview_round || (['1st_level', '2nd_level'].includes(currentStage) ? currentStage : null);
    const interviewRound = ROUND_LABELS[round] || ROUND_LABELS[currentStage] || currentStage;

    // 4. Save interview note
    // interviewer_id is interview_notes' FK to employees(id). It used to be taken
    // unconditionally from the schedule, so the note recorded who was BOOKED to
    // interview rather than who actually filed the assessment — and nothing
    // checked that the submitter was that person. Prefer the submitter's own
    // employee id and fall back to the scheduled interviewer for callers with no
    // employee record (the admin accounts), so attribution is real where it can be.
    await pool.query(
      `INSERT INTO interview_notes (candidate_id, interviewer_id, interview_round, rating, comments, recommendation, interview_id, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [schedule.candidate_id, (await employeeOf(req, pool)) ?? schedule.interviewer_id, interviewRound,
       rating ?? null, comments ?? null,
       outcome === 'selected' ? 'hire' : 'reject', schedule.id, schedule.company_id]
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
      // A technical or HR round records the result without moving the candidate;
      // a 1st level pass goes to 2nd level; 2nd level or final goes to offer.
      const effective = round || currentStage;
      if (effective === '1st_level' && ['1st_level', 'shortlisted', 'assessment', 'screening', 'applied'].includes(currentStage)) nextStage = '2nd_level';
      else if (['2nd_level', 'final'].includes(effective) && !['offer', 'selected', 'hired'].includes(currentStage)) nextStage = 'offer';
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

// Email templates are recruitment set-up: HR's, not a department head's
// (owner decision 2026-11-18). Reading stays open to the module.
async function setupOnly(req, res, next) {
  try {
    if (!(await canManageRecruitmentSetup(req))) return res.status(403).json({ error: 'Email templates are managed by HR.' });
    next();
  } catch (e) { respondError(res, e); }
}

router.post('/email-templates', add, setupOnly, validateBody(emailTemplateSchema), async (req, res) => {
  try {
    const template = await recruitmentRepository.createEmailTemplate(req.body, cid(req));
    res.status(201).json(template);
  } catch (error) {
    respondError(res, error);
  }
});

router.put('/email-templates/:id', edit, setupOnly, validatePatch(emailTemplateSchema), async (req, res) => {
  try {
    const current = await recruitmentRepository.findEmailTemplateById(req.params.id, null);
    if (!current || (current.company_id != null && String(current.company_id) !== String(cid(req)))) {
      return res.status(404).json({ error: 'Template not found' });
    }
    // A shared default is never edited in place (it belongs to every company):
    // saving it makes this company's own copy, which the sender then prefers.
    if (current.company_id == null) {
      const copy = await recruitmentRepository.createEmailTemplate({
        template_name: req.body.template_name ?? current.template_name ?? current.name,
        template_type: current.stage_trigger || current.template_type,
        subject: req.body.subject ?? current.subject,
        body_html: req.body.body_html ?? current.body_html,
        variables_json: current.variables_json ?? null,
        is_active: req.body.is_active !== false,
      }, cid(req));
      return res.status(201).json({ ...copy, copied_from_default: current.id });
    }
    const template = await recruitmentRepository.updateEmailTemplate(req.params.id, req.body, cid(req));
    res.json(template);
  } catch (error) {
    respondError(res, error);
  }
});

router.delete('/email-templates/:id', remove, setupOnly, async (req, res) => {
  try {
    const current = await recruitmentRepository.findEmailTemplateById(req.params.id, null);
    if (current && current.company_id == null) {
      return res.status(409).json({ error: 'This is a shared default. Edit it to make your own version, or switch your version off.' });
    }
    await recruitmentRepository.deleteEmailTemplate(req.params.id, cid(req));
    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    respondError(res, error);
  }
});

// What the recruitment screens need to know about the company's set-up, with
// no secrets: whether e-mail can go out at all (no SMTP = every candidate
// e-mail is silently skipped) and whether offers can become salary proposals.
router.get('/setup-status', view, async (req, res) => {
  try {
    const smtp = await resolveConfig(cid(req) ?? null, 'smtp').catch(() => ({}));
    const deptScope = await recruitmentDeptScope(req);
    res.json({
      email_configured: !!(smtp.SMTP_HOST && smtp.SMTP_USER),
      ctc_mode: await isCtcModeOn(cid(req)),
      // null = all departments; a list = a department head's own (owner, 11-18).
      dept_scope: deptScope,
      can_manage_setup: deptScope === null,
    });
  } catch (error) {
    respondError(res, error);
  }
});

// ==================== OFFERS ====================
// Business-local calendar day (process TZ is pinned — shared/timezone.js);
// toISOString() would be the UTC day, a day behind between 00:00 and 05:30 IST.
const isoOfLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => isoOfLocal(new Date());

// A department head sees and acts on offers for their own department(s) only
// (owner decision 2026-11-18). Out-of-scope offers answer 404, as if absent.
router.use('/offers/:id', async (req, res, next) => {
  try {
    const scope = await recruitmentDeptScope(req);
    if (scope === null) return next();
    const { rows: [o] } = await pool.query(
      `SELECT ${recordDepartmentSql('ol')} AS department FROM offer_letters ol
        WHERE ol.id::text = $1 AND ($2::int IS NULL OR ol.company_id = $2)`, [String(req.params.id), cid(req) ?? null]);
    if (o && !scope.includes(o.department)) return res.status(404).json({ error: 'Offer not found' });
    next();
  } catch (e) { respondError(res, e); }
});

router.get('/offers', view, async (req, res) => {
  try {
    const departments = await recruitmentDeptFilter(req, req.query.department);
    const offers = await recruitmentRepository.findOffers({
      ...req.query, department: undefined, departments: departments ?? undefined, company_id: cid(req),
    });
    res.json(offers);
  } catch (error) {
    respondError(res, error);
  }
});

// Offer letter PDF, generated from the current terms. A draft prints "DRAFT".
router.get('/offers/:id/letter.pdf', view, async (req, res) => {
  try {
    const out = await buildOfferLetterPdf(pool, {
      companyId: cid(req), offerId: req.params.id, signatoryUserId: req.user?.userId ?? req.user?.id ?? null,
    });
    if (!out) return res.status(404).json({ error: 'Offer not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${out.filename}"`);
    res.send(out.pdf);
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
    // The candidate and the job must be this company's, the candidate still in
    // the running, and no other offer of theirs may be open (one live offer per
    // candidate — migration 20261117000008 enforces it too).
    const { rows: [cand] } = await pool.query(
      `SELECT id, overall_status FROM candidates WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [req.body.candidate_id, cid(req)]);
    if (!cand) return res.status(404).json({ error: 'Candidate not found' });
    if (cand.overall_status && cand.overall_status !== 'active') {
      return res.status(409).json({ error: `This candidate is "${cand.overall_status}" — an offer can only be made to an active candidate.` });
    }
    // Department first, so a department head learns nothing about another
    // department's candidates (e.g. that they already hold an offer).
    const headScope = await recruitmentDeptScope(req);
    if (req.body.job_opening_id) {
      const { rows: [job] } = await pool.query(
        `SELECT id, department FROM job_openings WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [req.body.job_opening_id, cid(req)]);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (headScope && !headScope.includes(job.department)) return res.status(403).json({ error: `You can make offers only for ${headScope.join(', ') || 'your own department'}.` });
    } else if (headScope) {
      return res.status(400).json({ error: 'Choose the job for this offer.' });
    } else if (!String(req.body.designation || '').trim()) {
      return res.status(400).json({ error: 'Choose the job, or give the designation for the letter.' });
    }
    const { rows: [live] } = await pool.query(
      `SELECT offer_no, offer_status FROM offer_letters
        WHERE candidate_id = $1 AND deleted_at IS NULL AND offer_status IN ('draft','pending_approval','sent') LIMIT 1`,
      [req.body.candidate_id]);
    if (live) {
      return res.status(409).json({ error: `This candidate already has an open offer (${live.offer_no || 'no number'}, ${live.offer_status.replace(/_/g, ' ')}). Edit or withdraw it instead of drafting another.` });
    }
    if (!(Number(req.body.offered_salary) > 0)) return res.status(400).json({ error: 'Enter the annual CTC.' });
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
    const before = await recruitmentRepository.findOfferById(req.params.id, cid(req));
    if (!before) return res.status(404).json({ error: 'Offer not found' });
    // Terms are what the approver approves, so they can change only on a draft
    // (including one sent back). candidate_id never changes.
    const TERMS = ['job_opening_id', 'designation', 'offered_salary', 'joining_date', 'offer_expiry_date', 'notes'];
    const body = { ...req.body };
    delete body.candidate_id;
    const day = (d) => (d == null ? null : (d instanceof Date ? isoOfLocal(d) : String(d).slice(0, 10)));
    // OWNER DECISION 2026-11-18 (fixed): once sent, only the validity date may
    // change. A sent offer may have its validity EXTENDED (the candidate asked for more
    // time) — that changes no money term, so it needs no fresh approval.
    const onlyExtending = before.offer_status === 'sent'
      && Object.keys(body).every(k => k === 'offer_expiry_date')
      && body.offer_expiry_date;
    if (onlyExtending) {
      const cur = day(before.offer_expiry_date);
      if (cur && body.offer_expiry_date <= cur) {
        return res.status(400).json({ error: 'The new date must be later than the current one.' });
      }
      if (body.offer_expiry_date < todayIso()) {
        return res.status(400).json({ error: 'The new date cannot be in the past.' });
      }
    } else if (TERMS.some(k => body[k] !== undefined) && before.offer_status !== 'draft') {
      return res.status(409).json({ error: `This offer is "${before.offer_status.replace(/_/g, ' ')}" — only a draft offer can be edited. Withdraw it and draft a new one if the terms have changed.` });
    }
    if (before.offer_status === 'draft') {
      const exp = body.offer_expiry_date !== undefined ? body.offer_expiry_date : day(before.offer_expiry_date);
      const join = body.joining_date !== undefined ? body.joining_date : day(before.joining_date);
      if (exp && join && exp > join) return res.status(400).json({ error: 'The offer should expire before the joining date.' });
      if (body.offered_salary !== undefined && !(Number(body.offered_salary) > 0)) return res.status(400).json({ error: 'Enter the annual CTC.' });
    }
    // OWNER DECISION 2026-11-18 (fixed): accepted offers cannot be withdrawn.
    // An accepted offer is no longer withdrawable here: accepting hires the
    // candidate and creates the employee, and pulling the offer afterwards left
    // an employee with a "withdrawn" offer. A joiner who does not turn up is an
    // exit (Exit Management), not an offer change.
    const MOVES = {
      draft: ['pending_approval', 'withdrawn'],
      pending_approval: ['withdrawn'],
      sent: ['declined', 'withdrawn'],
    };
    const moving = body.offer_status !== undefined && body.offer_status !== before.offer_status;
    if (moving && !(MOVES[before.offer_status] || []).includes(body.offer_status)) {
      return res.status(409).json({ error: `An offer cannot move from "${before.offer_status.replace(/_/g, ' ')}" to "${body.offer_status.replace(/_/g, ' ')}".` });
    }
    if (moving && ['declined', 'withdrawn'].includes(body.offer_status)) {
      if (!String(body.close_reason || '').trim()) {
        return res.status(400).json({ error: body.offer_status === 'declined' ? 'Say why the candidate declined.' : 'Say why the offer is being withdrawn.' });
      }
      body.close_reason = String(body.close_reason).trim();
      body.response_date = todayIso();
    } else {
      delete body.close_reason;
    }
    if (moving && body.offer_status === 'pending_approval') {
      // What the approver approves must be complete.
      if (!(Number(before.offered_salary) > 0)) return res.status(400).json({ error: 'Enter the annual CTC before submitting.' });
      if (!before.joining_date) return res.status(400).json({ error: 'Enter the joining date before submitting — it goes on the letter.' });
    }
    const offer = await recruitmentRepository.updateOffer(req.params.id, body, cid(req));
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: null, recordType: 'offer', action: 'update', oldData: before, newData: offer, req });
    if (moving || onlyExtending) {
      const what = onlyExtending ? `Offer validity extended to ${body.offer_expiry_date}`
        : body.offer_status === 'declined' ? `Candidate declined the offer: ${body.close_reason}`
        : body.offer_status === 'withdrawn' ? `Offer withdrawn: ${body.close_reason}`
        : 'Offer submitted for approval';
      await candidateIntelligence.recordActivity({
        company_id: cid(req),
        candidate_id: before.candidate_id,
        event_type: onlyExtending ? 'offer_extended' : `offer_${body.offer_status}`,
        summary: what,
        detail: { offer_id: before.id, offer_no: before.offer_no || null },
        actor_user_id: req.user?.userId ?? req.user?.id ?? null,
        actor_name: await actorNameOf(req),
      }).catch(err => console.warn('[Recruitment] offer activity failed:', err.message));
    }
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
    // OWNER DECISION 2026-11-18 (fixed): an expired offer is accepted only with
    // an explicit confirmation (accept_late). Offers never expired: a "sent" offer stayed acceptable for ever. Past its
    // valid-until date it now needs an explicit "accept late" from the user
    // (or the validity extended first), so lapsing is a decision, not an accident.
    const current = await recruitmentRepository.findOfferById(req.params.id, cid(req));
    if (!current) return res.status(404).json({ error: 'Offer not found' });
    const exp = current.offer_expiry_date
      ? (current.offer_expiry_date instanceof Date ? isoOfLocal(current.offer_expiry_date) : String(current.offer_expiry_date).slice(0, 10))
      : null;
    if (current.offer_status === 'sent' && exp && exp < todayIso() && req.body?.accept_late !== true) {
      return res.status(409).json({ error: `This offer expired on ${exp}. Extend its validity, or confirm you are accepting it late.`, code: 'OFFER_EXPIRED', expired_on: exp });
    }
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
    // Period (when candidates came in) + department — the Dashboard filter bar.
    // Without ?period it stays all-time, as before, for any other caller.
    const range = req.query.period
      ? resolveRange(req.query, { defaultPeriod: 'fytd' })
      : { from: null, to: null };
    const analytics = await recruitmentRepository.getSourceAnalytics(cid(req), {
      from: range.from, to: range.to, department: dimension(req.query, 'department'),
    });
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
// New joiners (recent hires + people added directly) and how far their onboarding
// has got. Recruitment does NOT own onboarding — HR does, in
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
    const params = [company_id, await recruitmentDeptFilter(req)];
    // `total` is the count of active checklist templates, matching how
    // GET /hr/onboarding/progress/:employee_id computes its denominator — progress
    // rows only exist for items someone has touched, so counting those instead
    // would report 3/3 complete for an employee with 3 done and 20 untouched.
    // Owner 18 Nov 26: onboarding lives in ONE place (this page; the Employee
    // Profile tab was removed), so the list is every new joiner — hired through
    // Recruitment in the last 60 days, AND anyone added directly (Add Employee,
    // intern conversion) whose record was created or who joined in that window.
    // `key` is unique across both kinds; `source` tells them apart.
    const query = `
      WITH tpl AS (
        SELECT COUNT(*)::int AS total
          FROM hr_onboarding_checklist_templates t
         WHERE t.is_active = true AND (t.company_id IS NULL OR t.company_id = $1)
      ),
      hires AS (
        SELECT 'c' || c.id AS key, 'recruitment' AS source, c.id AS candidate_id,
               c.full_name AS name, c.email, c.phone,
               COALESCE(e.designation, jo.job_title, jr.job_title) AS designation,
               COALESCE(e.department, jo.department, jr.department) AS department,
               c.hired_at AS sort_at,
               TO_CHAR(c.hired_at::date, 'YYYY-MM-DD') AS hired_on,
               -- The day they actually join (employee record, else the accepted offer).
               TO_CHAR(COALESCE(e.joining_date,
                 (SELECT o.joining_date FROM offer_letters o
                   WHERE o.candidate_id = c.id AND o.offer_status = 'accepted' AND o.deleted_at IS NULL
                   ORDER BY o.updated_at DESC NULLS LAST LIMIT 1)), 'YYYY-MM-DD') AS joining_date,
               -- NULL = the hire never produced an employee record (auto-creation
               -- failed, see recruitment_employee_creation_log) — surfaced, not hidden.
               e.id AS employee_id, e.office_id AS employee_code
          FROM candidates c
          LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
          LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
          LEFT JOIN employees e ON e.source_candidate_id = c.id AND e.deleted_at IS NULL
         WHERE c.overall_status = 'hired'
           AND c.hired_at >= NOW() - INTERVAL '60 days'
           AND c.deleted_at IS NULL
           AND ($1::int IS NULL OR c.company_id = $1)
           AND ($2::text[] IS NULL OR COALESCE(e.department, jo.department, jr.department) = ANY($2::text[]))
      ),
      direct AS (
        SELECT 'e' || e.id AS key, 'direct' AS source, NULL::int AS candidate_id,
               e.name, COALESCE(e.company_email, e.personal_email) AS email, NULL::text AS phone,
               e.designation, e.department,
               e.created_at AS sort_at,
               NULL::text AS hired_on,
               TO_CHAR(e.joining_date, 'YYYY-MM-DD') AS joining_date,
               e.id AS employee_id, e.office_id AS employee_code
          FROM employees e
         WHERE e.deleted_at IS NULL
           AND e.source_candidate_id IS NULL
           AND COALESCE(e.is_test, false) = false
           AND e.exit_date IS NULL
           AND COALESCE(LOWER(e.status), '') NOT IN ('exited', 'inactive', 'terminated', 'resigned', 'relieved')
           AND (e.created_at >= NOW() - INTERVAL '60 days' OR e.joining_date >= CURRENT_DATE - 60)
           AND ($1::int IS NULL OR e.company_id = $1)
           AND ($2::text[] IS NULL OR e.department = ANY($2::text[]))
      )
      SELECT x.*, tpl.total AS onboarding_total,
             COALESCE((SELECT COUNT(*) FILTER (WHERE p.done) FROM hr_onboarding_checklist_progress p
                        WHERE p.employee_id = x.employee_id), 0)::int AS onboarding_done
        FROM (SELECT * FROM hires UNION ALL SELECT * FROM direct) x CROSS JOIN tpl
       ORDER BY x.sort_at DESC`;
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
    const { from_date, to_date } = req.query;
    const department = await recruitmentDeptFilter(req, req.query.department);
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
    const department = await recruitmentDeptFilter(req, req.query.department);
    const data = await recruitmentRepository.getVacancyAging({ company_id, from_date, to_date, department });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/reports/source-effectiveness', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const department = await recruitmentDeptFilter(req, req.query.department);
    const data = await recruitmentRepository.getSourceEffectiveness({ company_id, from_date, to_date, department });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

router.get('/reports/department-pipeline', view, async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const department = await recruitmentDeptFilter(req, req.query.department);
    const data = await recruitmentRepository.getDepartmentPipeline({ company_id, from_date, to_date, department });
    res.json(data);
  } catch (error) {
    respondError(res, error);
  }
});

// Hiring Forecasts tab: demand (requisitions + open jobs), pipeline and the
// company's hiring rates, by department.
router.get('/reports/forecast', view, async (req, res) => {
  try {
    const department = await recruitmentDeptFilter(req, req.query.department);
    res.json(await recruitmentRepository.getHiringForecast({ company_id: cid(req), department, within_days: req.query.within_days }));
  } catch (error) {
    respondError(res, error);
  }
});

// Offers made in the period: outcome, decline / withdraw reasons, days to answer.
router.get('/reports/offers', view, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const department = await recruitmentDeptFilter(req, req.query.department);
    res.json(await recruitmentRepository.getOffersReport({ company_id: cid(req), from_date, to_date, department }));
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
             o.offered_salary, o.joining_date, o.designation, o.offer_no,
             ecl.status AS creation_status, ecl.employee_code, ecl.triggered_at, ecl.error_log
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        -- LATERAL, latest row only: a plain join listed a candidate once per
        -- accepted offer and once per creation attempt (failed, then retried).
        LEFT JOIN LATERAL (SELECT o2.offered_salary, o2.joining_date, o2.designation, o2.offer_no
                             FROM offer_letters o2
                            WHERE o2.candidate_id = c.id AND o2.offer_status = 'accepted' AND o2.deleted_at IS NULL
                            ORDER BY o2.updated_at DESC NULLS LAST LIMIT 1) o ON TRUE
        LEFT JOIN LATERAL (SELECT l.status, l.employee_code, l.triggered_at, l.error_log
                             FROM recruitment_employee_creation_log l
                            WHERE l.candidate_id = c.id AND l.company_id = $1
                            ORDER BY l.triggered_at DESC NULLS LAST, l.id DESC LIMIT 1) ecl ON TRUE
       WHERE c.company_id = $1 AND LOWER(c.current_stage) = 'hired' AND c.deleted_at IS NULL
         AND ($2::text[] IS NULL OR jo.department = ANY($2::text[]))
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
    `, [cid(req), await recruitmentDeptFilter(req)]);
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
    const headScope = await recruitmentDeptScope(req);
    if (headScope) {
      const { rows: [c] } = await pool.query(
        `SELECT jo.department FROM candidates c LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
          WHERE c.id::text = $1 AND c.company_id = $2`, [String(candidate_id), company_id]);
      if (!c || !headScope.includes(c.department)) return res.status(404).json({ error: 'Candidate not found' });
    }

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
      // What was actually done and what is still open — the same list the
      // creation log keeps (it used to be four hard-coded strings).
      checklist: result.checklist || [],
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
        LEFT JOIN job_openings jo ON jo.id = ecl.job_opening_id
       WHERE ecl.company_id = $1
         AND ($2::text[] IS NULL OR jo.department = ANY($2::text[]))
       ORDER BY ecl.triggered_at DESC LIMIT 100
    `, [cid(req), await recruitmentDeptFilter(req)]);
    res.json(rows);
  } catch (err) { respondError(res, err); }
});

export default router;
