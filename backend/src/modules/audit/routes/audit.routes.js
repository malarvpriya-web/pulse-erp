import express from 'express';
import auditRepository from '../repositories/audit.repository.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const logs = await auditRepository.findAll(req.query);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reference/:reference_id/:reference_type', async (req, res) => {
  try {
    const logs = await auditRepository.findByReference(req.params.reference_id, req.params.reference_type);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/activity-summary', async (req, res) => {
  try {
    const summary = await auditRepository.getActivitySummary(req.query);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const log = await auditRepository.create({
      ...req.body,
      user_id: req.user?.id,
      ip_address: req.ip,
      user_agent: req.get('user-agent')
    });
    res.status(201).json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
