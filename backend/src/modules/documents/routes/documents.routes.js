import express from 'express';
import documentsRepository from '../repositories/documents.repository.js';

const router = express.Router();

// Templates
router.get('/templates', async (req, res) => {
  try {
    const templates = await documentsRepository.findTemplates(req.query);
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const template = await documentsRepository.findTemplateById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const template = await documentsRepository.createTemplate({ ...req.body, created_by: req.user?.id });
    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const template = await documentsRepository.updateTemplate(req.params.id, req.body);
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await documentsRepository.deleteTemplate(req.params.id);
    res.json({ message: 'Template deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generated Documents
router.get('/generated', async (req, res) => {
  try {
    const documents = await documentsRepository.findGeneratedDocuments(req.query);
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const document = await documentsRepository.saveGeneratedDocument({ ...req.body, generated_by: req.user?.id });
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
