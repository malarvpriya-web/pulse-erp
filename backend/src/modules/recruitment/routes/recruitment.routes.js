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
import { createNotification } from '../../../services/notificationService.js';
import { logAudit } from '../../../services/AuditService.js';
import { triggerEmail } from '../../../services/emailTrigger.js';
import { companyOf } from '../../../shared/scope.js';

const notify = (userId, module, recordId, message) => {
  if (!userId) return;
  createNotification(pool, userId, module, recordId, message).catch(() => {});
};

const router = express.Router();

// Bootstrap: create interview_schedules and offer_letters tables if they don't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS interview_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID,
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
    candidate_id UUID,
    job_opening_id UUID,
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
router.get('/dashboard-summary', async (req, res) => {
  try {
    const data = await recruitmentRepository.getDashboard(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Keep /dashboard for backwards compat
router.get('/dashboard', async (req, res) => {
  try {
    const data = await recruitmentRepository.getDashboard(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PIPELINE SUMMARY ====================
router.get('/pipeline-summary', async (req, res) => {
  try {
    const rows = await recruitmentRepository.getPipelineSummary(cid(req));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== JOB REQUISITIONS ====================
router.get('/requisitions', async (req, res) => {
  try {
    const requisitions = await recruitmentRepository.findRequisitions({
      ...req.query, company_id: cid(req),
    });
    res.json(requisitions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/requisitions/:id', async (req, res) => {
  try {
    const requisition = await recruitmentRepository.findRequisitionById(req.params.id, cid(req));
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    res.json(requisition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/requisitions', async (req, res) => {
  try {
    const requisition = await recruitmentRepository.createRequisition({
      ...req.body, company_id: cid(req),
    });
    res.status(201).json(requisition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/requisitions/:id', async (req, res) => {
  try {
    const requisition = await recruitmentRepository.updateRequisition(req.params.id, req.body);
    res.json(requisition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/requisitions/:id', async (req, res) => {
  try {
    await recruitmentRepository.deleteRequisition(req.params.id);
    res.json({ message: 'Requisition deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== JOB OPENINGS ====================
router.get('/openings', async (req, res) => {
  try {
    const openings = await recruitmentRepository.findOpenings({
      ...req.query, company_id: cid(req),
    });
    res.json(openings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/openings/:id', async (req, res) => {
  try {
    const opening = await recruitmentRepository.findOpeningById(req.params.id, cid(req));
    if (!opening) return res.status(404).json({ error: 'Opening not found' });
    res.json(opening);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/openings', async (req, res) => {
  try {
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
    res.status(500).json({ error: error.message });
  }
});

router.put('/openings/:id', async (req, res) => {
  try {
    const opening = await recruitmentRepository.updateOpening(req.params.id, req.body);
    res.json(opening);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CANDIDATES ====================
router.get('/candidates', async (req, res) => {
  try {
    const candidates = await recruitmentRepository.findCandidates({
      ...req.query, company_id: cid(req),
    });
    res.json(candidates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/candidates/:id', async (req, res) => {
  try {
    const candidate = await recruitmentRepository.findCandidateById(req.params.id, cid(req));
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json(candidate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/candidates', upload.single('resume'), async (req, res) => {
  try {
    const data = { ...req.body, company_id: cid(req) };
    if (req.file) {
      data.resume_file_url = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    }
    const candidate = await recruitmentRepository.createCandidate(data);

    // Notify recruiter of new application
    notify(req.user?.user_id, 'recruitment', candidate.id,
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
    res.status(500).json({ error: error.message });
  }
});

router.post('/candidates/bulk', upload.array('resumes'), async (req, res) => {
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
    res.status(201).json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/candidates/:id', async (req, res) => {
  try {
    const candidate = await recruitmentRepository.updateCandidate(req.params.id, req.body);
    res.json(candidate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/candidates/:id/move-stage', async (req, res) => {
  try {
    const { new_stage, moved_by, notes } = req.body;
    await recruitmentRepository.moveCandidateStage(req.params.id, new_stage, moved_by, notes);

    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'candidate', action: 'stage_change', newData: { stage: new_stage }, req });

    // Move resume in Google Drive async (non-blocking)
    moveResumeOnStageChange(req.params.id, new_stage).catch(err =>
      console.warn('[Drive] moveResumeOnStageChange failed:', err.message)
    );

    res.json({ message: 'Candidate moved to new stage' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/candidates/:id/history', async (req, res) => {
  try {
    const history = await recruitmentRepository.getCandidateStageHistory(req.params.id);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== HIRE CANDIDATE (full transaction) ====================
router.post('/candidates/:id/hire', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { employee, employeeId } = await recruitmentRepository.hireCandidate(
      req.params.id,
      cid(req),
      client
    );

    // Move resume to Hired folder (non-blocking, outside transaction)
    moveResumeOnStageChange(req.params.id, 'hired').catch(err =>
      console.warn('[Drive] hire moveResume failed:', err.message)
    );

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'candidate', action: 'hire', newData: { employee_id: employeeId }, req });
    // Notify HR of new hire
    notify(req.user?.user_id, 'recruitment', parseInt(req.params.id),
      `${employee.first_name} ${employee.last_name} has been hired and added as employee ${employeeId}`);
    triggerEmail('hired_welcome', {
      candidate_email: employee.company_email || '',
      candidate_name:  `${employee.first_name} ${employee.last_name}`,
      employee_id:     employeeId,
      joining_date:    employee.joining_date  || '',
    }, cid(req));
    res.json({ success: true, employee_id: employeeId, employee });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// ==================== PIPELINE ====================
router.get('/pipeline/:job_opening_id', async (req, res) => {
  try {
    const pipeline = await recruitmentRepository.getCandidatePipeline(req.params.job_opening_id);
    res.json(pipeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/pipeline/:job_opening_id/:stage', async (req, res) => {
  try {
    const candidates = await recruitmentRepository.getCandidatesByStage(
      req.params.job_opening_id, req.params.stage
    );
    res.json(candidates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== INTERVIEW NOTES ====================
router.post('/interview-notes', async (req, res) => {
  try {
    const note = await recruitmentRepository.createInterviewNote(req.body);
    res.status(201).json(note);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/interview-notes/:candidate_id', async (req, res) => {
  try {
    const notes = await recruitmentRepository.findInterviewNotes(req.params.candidate_id);
    res.json(notes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== INTERVIEWS ====================
router.get('/interviews', async (req, res) => {
  try {
    const interviews = await recruitmentRepository.findInterviews({
      ...req.query, company_id: cid(req),
    });
    res.json(interviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/interviews', async (req, res) => {
  try {
    const interview = await recruitmentRepository.scheduleInterview({
      ...req.body, company_id: cid(req),
    });
    // Notify interviewer
    if (interview.interviewer_id) {
      const empRes = await pool.query('SELECT user_id FROM employees WHERE id = $1', [interview.interviewer_id]).catch(() => ({ rows: [] }));
      const interviewerUserId = empRes.rows[0]?.user_id;
      notify(interviewerUserId, 'recruitment', interview.id,
        `Interview scheduled on ${interview.interview_date} — check your calendar`);
    }
    triggerEmail('interview_l1_scheduled', {
      candidate_email:  interview.candidate_email || '',
      candidate_name:   interview.candidate_name  || '',
      interview_date:   interview.interview_date  || '',
      interview_mode:   interview.mode            || '',
    }, cid(req));
    res.status(201).json(interview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/interviews/:id', async (req, res) => {
  try {
    const interview = await recruitmentRepository.updateInterview(req.params.id, req.body);
    res.json(interview);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== INTERVIEW FEEDBACK + AUTO-PROGRESSION ====================
router.post('/interviews/:id/submit-feedback', async (req, res) => {
  try {
    const { outcome, rejection_reason, rating, comments } = req.body;

    if (!outcome || !['selected', 'rejected'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be "selected" or "rejected"' });
    }
    if (outcome === 'rejected' && !rejection_reason) {
      return res.status(400).json({ error: 'rejection_reason is required when outcome is rejected' });
    }

    // 1. Load interview schedule → get candidate_id
    const schedRes = await pool.query('SELECT * FROM interview_schedules WHERE id = $1', [req.params.id]);
    if (!schedRes.rows.length) return res.status(404).json({ error: 'Interview not found' });
    const schedule = schedRes.rows[0];

    // 2. Load candidate → get current_stage
    const candRes = await pool.query('SELECT * FROM candidates WHERE id = $1', [schedule.candidate_id]);
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
        req.user?.userId ?? req.user?.id,
        rejection_reason || `Interview outcome: ${outcome}`
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
      notify(req.user?.user_id, 'recruitment', parseInt(schedule.candidate_id),
        `${candidate.full_name} passed L1 — schedule 2nd Level Interview`);
    } else if (nextStage === 'offer') {
      notify(req.user?.user_id, 'recruitment', parseInt(schedule.candidate_id),
        `${candidate.full_name} passed L2 — create offer letter`);
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
    res.status(500).json({ error: error.message });
  }
});

// ==================== EMAIL TEMPLATES ====================
router.get('/email-templates', async (req, res) => {
  try {
    const templates = await recruitmentRepository.findEmailTemplates(req.query);
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/email-templates/:id', async (req, res) => {
  try {
    const template = await recruitmentRepository.findEmailTemplateById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/email-templates', async (req, res) => {
  try {
    const template = await recruitmentRepository.createEmailTemplate(req.body);
    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/email-templates/:id', async (req, res) => {
  try {
    const template = await recruitmentRepository.updateEmailTemplate(req.params.id, req.body);
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/email-templates/:id', async (req, res) => {
  try {
    await recruitmentRepository.deleteEmailTemplate(req.params.id);
    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== OFFERS ====================
router.get('/offers', async (req, res) => {
  try {
    const offers = await recruitmentRepository.findOffers({
      ...req.query, company_id: cid(req),
    });
    res.json(offers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/offers/:id', async (req, res) => {
  try {
    const offer = await recruitmentRepository.findOfferById(req.params.id, cid(req));
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/offers', async (req, res) => {
  try {
    const offer = await recruitmentRepository.createOffer({
      ...req.body, company_id: cid(req),
    });
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: offer.id, recordType: 'offer', action: 'create', newData: offer, req });
    res.status(201).json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/offers/:id', async (req, res) => {
  try {
    const offer = await recruitmentRepository.updateOffer(req.params.id, req.body);
    // Notify when offer is sent
    if (req.body.offer_status === 'sent') {
      notify(req.user?.user_id, 'recruitment', offer.id,
        `Offer letter sent to ${offer.candidate_name || 'candidate'}`);
      triggerEmail('offer_sent', {
        candidate_email: offer.candidate_email || '',
        candidate_name:  offer.candidate_name  || '',
        offer_date:      offer.offer_date       || '',
        designation:     offer.designation      || '',
        ctc:             offer.ctc              || '',
      }, cid(req));
    }
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/offers/:id/accept', async (req, res) => {
  try {
    const offer = await recruitmentRepository.acceptOffer(req.params.id);
    logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'Recruitment', recordId: parseInt(req.params.id), recordType: 'offer', action: 'accept', newData: offer, req });
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ANALYTICS ====================
router.get('/analytics/source', async (req, res) => {
  try {
    const analytics = await recruitmentRepository.getSourceAnalytics(cid(req));
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/time-to-hire', async (req, res) => {
  try {
    const data = await recruitmentRepository.getTimeToHire(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/offer-acceptance-rate', async (req, res) => {
  try {
    const data = await recruitmentRepository.getOfferAcceptanceRate(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/interview-to-hire-ratio', async (req, res) => {
  try {
    const data = await recruitmentRepository.getInterviewToHireRatio(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ONBOARDING ====================
router.get('/onboarding', async (req, res) => {
  try {
    const company_id = cid(req);
    const params = [];
    let query = `
      SELECT c.id, c.full_name AS name, c.email, c.phone,
             COALESCE(jo.job_title, jr.job_title) AS designation,
             COALESCE(jo.department, jr.department) AS department,
             TO_CHAR(c.hired_at::date, 'YYYY-MM-DD') AS joining_date
      FROM candidates c
      LEFT JOIN job_openings jo ON c.applied_job_id = jo.id
      LEFT JOIN job_requisitions jr ON jo.requisition_id = jr.id
      WHERE c.overall_status = 'hired'
        AND c.hired_at >= NOW() - INTERVAL '60 days'
        AND c.deleted_at IS NULL`;
    if (company_id) { query += ` AND c.company_id = $1`; params.push(company_id); }
    query += ` ORDER BY c.hired_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS ====================
router.get('/reports/summary', async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date, department } = req.query;
    const data = await recruitmentRepository.getReportsSummary({ company_id, from_date, to_date, department });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/vacancy-aging', async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getVacancyAging({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/source-effectiveness', async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getSourceEffectiveness({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reports/department-pipeline', async (req, res) => {
  try {
    const company_id = cid(req);
    const { from_date, to_date } = req.query;
    const data = await recruitmentRepository.getDepartmentPipeline({ company_id, from_date, to_date });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PHASE 51 — EMPLOYEE AUTO-CREATION (Hired → Employee Master)
// =============================================================================

// GET /recruitment/auto-creation/pending — candidates in Hired status without employee record
router.get('/auto-creation/pending', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.full_name, c.email, c.phone, c.current_stage, c.applied_job_id AS job_opening_id,
             jo.job_title, jo.department, jo.location,
             o.offered_salary, o.joining_date,
             ecl.status AS creation_status, ecl.employee_code, ecl.triggered_at, ecl.error_log
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        LEFT JOIN offer_letters o ON o.candidate_id = c.id AND LOWER(COALESCE(o.offer_status, o.status, '')) = 'accepted'
        LEFT JOIN recruitment_employee_creation_log ecl ON ecl.candidate_id = c.id AND ecl.company_id = $1
       WHERE c.company_id = $1 AND LOWER(c.current_stage) = 'hired'
       ORDER BY o.joining_date ASC NULLS LAST, c.updated_at DESC
    `, [cid(req)]);
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

// POST /recruitment/auto-creation/:candidateId/trigger — create employee from hired candidate
router.post('/auto-creation/:candidateId/trigger', async (req, res) => {
  try {
    const company_id = cid(req);
    const candidate_id = req.params.candidateId; // UUID — do NOT parseInt
    const triggered_by = req.user?.userId ?? req.user?.id ?? null;

    // Fetch candidate + offer data
    const { rows: candidates } = await pool.query(`
      SELECT c.*, jo.job_title, jo.department, jo.location, jo.employment_type,
             o.offered_salary, o.joining_date
        FROM candidates c
        LEFT JOIN job_openings jo ON jo.id = c.applied_job_id
        LEFT JOIN offer_letters o ON o.candidate_id = c.id AND o.offer_status = 'accepted'
       WHERE c.id = $1 AND c.company_id = $2
    `, [candidate_id, company_id]);

    if (!candidates.length) return res.status(404).json({ error: 'Candidate not found' });
    const c = candidates[0];
    if ((c.current_stage || '').toLowerCase() !== 'hired') return res.status(400).json({ error: 'Candidate must be in Hired stage' });

    // Check if already created
    const { rows: existing } = await pool.query(
      `SELECT * FROM recruitment_employee_creation_log WHERE candidate_id = $1 AND company_id = $2 AND status = 'completed'`,
      [candidate_id, company_id]
    );
    if (existing.length) return res.status(409).json({ error: 'Employee already created for this candidate', employee_code: existing[0].employee_code });

    // Generate employee code (MAX-based to survive deletions)
    const { rows: empMax } = await pool.query(
      `SELECT COALESCE(MAX(CAST(REGEXP_REPLACE(office_id,'[^0-9]','','g') AS INT)), 0) AS max_num
         FROM employees WHERE company_id = $1 AND office_id ~ '^EMP-[0-9]+'`,
      [company_id]
    );
    const emp_number = (empMax[0].max_num || 0) + 1;
    const emp_code = `EMP-${String(emp_number).padStart(4, '0')}`;

    // Create log entry first (pending)
    const { rows: logRows } = await pool.query(`
      INSERT INTO recruitment_employee_creation_log
        (company_id, candidate_id, candidate_name, job_opening_id, job_title, employee_code, status, triggered_by)
      VALUES ($1,$2,$3,$4,$5,$6,'in_progress',$7)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [company_id, candidate_id, c.full_name, c.job_opening_id, c.job_title, emp_code, triggered_by]);

    const logId = logRows[0]?.id;

    // Insert employee record
    let employee_id = null;
    try {
      const nameParts = (c.full_name || '').split(' ');
      const first_name = nameParts[0] || c.full_name;
      const last_name = nameParts.slice(1).join(' ') || '';

      const { rows: empRows } = await pool.query(`
        INSERT INTO employees
          (company_id, office_id, first_name, last_name, company_email, phone,
           department, designation, employment_type, joining_date, status,
           source_candidate_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11)
        RETURNING id, office_id, first_name, last_name, company_email
      `, [company_id, emp_code, first_name, last_name, c.email, c.phone,
          c.department || 'General', c.job_title || 'Staff',
          c.employment_type || 'Full-time',
          c.joining_date || new Date().toISOString().split('T')[0],
          candidate_id]);

      employee_id = empRows[0].id;

      // Build auto-creation checklist
      const checklist_items = [
        { task: 'Employee record created', done: true, note: `Code: ${emp_code}` },
        { task: 'Official email request pending', done: false },
        { task: 'Onboarding checklist to be created', done: false },
        { task: 'Attendance profile to be configured', done: false },
        { task: 'Leave profile to be configured', done: false },
        { task: 'Payroll profile to be configured', done: false },
        { task: 'Document folder to be created', done: false },
        { task: 'Org chart node to be added', done: false },
      ];

      // Update log to completed
      await pool.query(`
        UPDATE recruitment_employee_creation_log
           SET status = 'completed', employee_id = $1, completed_at = NOW(),
               checklist_items = $2
         WHERE id = $3
      `, [employee_id, JSON.stringify(checklist_items), logId]);

      // Notify HR
      notify(triggered_by, 'recruitment', candidate_id,
        `Employee ${emp_code} created for ${c.full_name} — pending onboarding setup`);

    } catch (empErr) {
      await pool.query(`UPDATE recruitment_employee_creation_log SET status='failed', error_log=$1 WHERE id=$2`, [empErr.message, logId]);
      return res.status(500).json({ error: `Employee creation failed: ${empErr.message}` });
    }

    res.status(201).json({
      message: 'Employee created successfully',
      employee_id,
      employee_code: emp_code,
      candidate_name: c.full_name,
      next_steps: ['Configure payroll profile', 'Set up leave balance', 'Create email account', 'Add to org chart'],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /recruitment/auto-creation/log — creation history
router.get('/auto-creation/log', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ecl.*, c.email AS candidate_email
        FROM recruitment_employee_creation_log ecl
        LEFT JOIN candidates c ON c.id = ecl.candidate_id
       WHERE ecl.company_id = $1
       ORDER BY ecl.triggered_at DESC LIMIT 100
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
