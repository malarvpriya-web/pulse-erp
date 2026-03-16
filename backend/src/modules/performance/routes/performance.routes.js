import express from 'express';
import performanceRepository from '../repositories/performance.repository.js';

const router = express.Router();

// Goals
router.get('/goals', async (req, res) => {
  try {
    const goals = await performanceRepository.findGoals(req.query);
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/goals', async (req, res) => {
  try {
    const goal = await performanceRepository.createGoal(req.body);
    res.status(201).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/goals/:id', async (req, res) => {
  try {
    const goal = await performanceRepository.updateGoal(req.params.id, req.body);
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reviews
router.get('/reviews', async (req, res) => {
  try {
    const reviews = await performanceRepository.findReviews(req.query);
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reviews/:id', async (req, res) => {
  try {
    const review = await performanceRepository.findReviewById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reviews', async (req, res) => {
  try {
    const review = await performanceRepository.createReview(req.body);
    res.status(201).json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/reviews/:id', async (req, res) => {
  try {
    const review = await performanceRepository.updateReview(req.params.id, req.body);
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reviews/:id/self-review', async (req, res) => {
  try {
    const review = await performanceRepository.submitSelfReview(req.params.id, req.body);
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reviews/:id/manager-review', async (req, res) => {
  try {
    const review = await performanceRepository.submitManagerReview(req.params.id, req.body);
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
router.get('/analytics/top-performers', async (req, res) => {
  try {
    const limit = req.query.limit || 10;
    const performers = await performanceRepository.getTopPerformers(limit);
    res.json(performers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/department-performance', async (req, res) => {
  try {
    const data = await performanceRepository.getDepartmentPerformance();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/goal-completion', async (req, res) => {
  try {
    const data = await performanceRepository.getGoalCompletionRate();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
