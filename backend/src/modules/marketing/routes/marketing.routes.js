import express from 'express';
import campaignsRepository from '../repositories/campaigns.repository.js';

const router = express.Router();

router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await campaignsRepository.findAll(req.query);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaignsRepository.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const campaign = await campaignsRepository.create({ ...req.body, created_by: req.user?.id });
    res.status(201).json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaignsRepository.update(req.params.id, req.body);
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    await campaignsRepository.delete(req.params.id);
    res.json({ message: 'Campaign deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/campaigns/:id/link-lead', async (req, res) => {
  try {
    await campaignsRepository.linkLead(req.params.id, req.body.lead_id);
    res.json({ message: 'Lead linked to campaign' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/campaigns/:id/leads', async (req, res) => {
  try {
    const leads = await campaignsRepository.getLeads(req.params.id);
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/campaigns/:id/metrics', async (req, res) => {
  try {
    const metrics = await campaignsRepository.getMetrics(req.params.id);
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
router.get('/analytics/leads-by-campaign', async (req, res) => {
  try {
    const data = await campaignsRepository.getLeadsByCampaign();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/campaign-roi', async (req, res) => {
  try {
    const data = await campaignsRepository.getCampaignROI();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
