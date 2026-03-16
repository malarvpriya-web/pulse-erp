import express from 'express';
import multer from 'multer';
import path from 'path';
import recruitmentRepository from '../repositories/recruitment.repository.js';

const router = express.Router();

// Multer configuration for resume uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + file.originalname);
  }
});
const upload = multer({ storage });

// ==================== JOB REQUISITIONS ====================
router.get('/requisitions', async (req, res) => {
  try {
    const requisitions = await recruitmentRepository.findRequisitions(req.query);
    res.json(requisitions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/requisitions/:id', async (req, res) => {
  try {
    const requisition = await recruitmentRepository.findRequisitionById(req.params.id);
    if (!requisition) return res.status(404).json({ error: 'Requisition not found' });
    res.json(requisition);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/requisitions', async (req, res) => {
  try {
    const requisition = await recruitmentRepository.createRequisition(req.body);
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
    const openings = await recruitmentRepository.findOpenings(req.query);
    res.json(openings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/openings/:id', async (req, res) => {
  try {
    const opening = await recruitmentRepository.findOpeningById(req.params.id);
    if (!opening) return res.status(404).json({ error: 'Opening not found' });
    res.json(opening);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/openings', async (req, res) => {
  try {
    const opening = await recruitmentRepository.createOpening(req.body);
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
    const candidates = await recruitmentRepository.findCandidates(req.query);
    res.json(candidates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/candidates/:id', async (req, res) => {
  try {
    const candidate = await recruitmentRepository.findCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json(candidate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/candidates', upload.single('resume'), async (req, res) => {
  try {
    const data = { ...req.body };
    if (req.file) {
      data.resume_file_url = `/uploads/${req.file.filename}`;
    }
    const candidate = await recruitmentRepository.createCandidate(data);
    res.status(201).json(candidate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/candidates/bulk', upload.array('resumes'), async (req, res) => {
  try {
    const candidates = JSON.parse(req.body.candidates);
    if (req.files && req.files.length > 0) {
      req.files.forEach((file, index) => {
        if (candidates[index]) {
          candidates[index].resume_file_url = `/uploads/${file.filename}`;
        }
      });
    }
    const results = await recruitmentRepository.bulkCreateCandidates(candidates);
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
    const candidates = await recruitmentRepository.getCandidatesByStage(req.params.job_opening_id, req.params.stage);
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
    const interviews = await recruitmentRepository.findInterviews(req.query);
    res.json(interviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/interviews', async (req, res) => {
  try {
    const interview = await recruitmentRepository.scheduleInterview(req.body);
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
    const offers = await recruitmentRepository.findOffers(req.query);
    res.json(offers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/offers/:id', async (req, res) => {
  try {
    const offer = await recruitmentRepository.findOfferById(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/offers', async (req, res) => {
  try {
    const offer = await recruitmentRepository.createOffer(req.body);
    res.status(201).json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/offers/:id', async (req, res) => {
  try {
    const offer = await recruitmentRepository.updateOffer(req.params.id, req.body);
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/offers/:id/accept', async (req, res) => {
  try {
    const offer = await recruitmentRepository.acceptOffer(req.params.id);
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ANALYTICS ====================
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await recruitmentRepository.getDashboard();
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/source', async (req, res) => {
  try {
    const analytics = await recruitmentRepository.getSourceAnalytics();
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/time-to-hire', async (req, res) => {
  try {
    const data = await recruitmentRepository.getTimeToHire();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/offer-acceptance-rate', async (req, res) => {
  try {
    const data = await recruitmentRepository.getOfferAcceptanceRate();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/interview-to-hire-ratio', async (req, res) => {
  try {
    const data = await recruitmentRepository.getInterviewToHireRatio();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
