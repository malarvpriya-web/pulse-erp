/**
 * Audit routes — read-only admin endpoints.
 *
 * Immutability: there is intentionally NO POST / PUT / DELETE route here.
 * Audit records are only written via AuditService (server-side, non-blocking).
 * Any attempt to write directly through a route would bypass the server-side
 * integrity layer, so that surface is simply absent.
 *
 * Auth:  all routes require a valid JWT.
 * Roles: read access is restricted to admin, hr, and manager.
 *
 * Endpoints:
 *   GET /audit/stats                           — aggregate counts
 *   GET /audit/                                — paginated log with filters
 *   GET /audit/trail                           — rich trail by module / record / date range
 *   GET /audit/reference/:id/:type             — all events for one entity
 */

import express from 'express';
import { allowRoles } from '../../../middlewares/auth.middleware.js';
import auditRepository from '../repositories/audit.repository.js';

const router = express.Router();

// verifyToken is already applied by server.js before mounting this router.
// Only add the role guard here — no second token verification needed.
router.use(allowRoles('super_admin', 'admin', 'hr', 'manager'));

// ── Aggregate stats ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await auditRepository.getStats({
      ...req.query,
      company_id: req.scope?.company_id ?? null,
    });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Paginated log with optional filters ───────────────────────────────────────
// Query params: module_name, action_type, search, start_date, end_date, limit, offset
router.get('/', async (req, res) => {
  try {
    const result = await auditRepository.findAll({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin trail — module / record / date range ────────────────────────────────
// Query params: module (required), record_id, record_type, start_date, end_date, limit, offset
router.get('/trail', async (req, res) => {
  try {
    const { module: module_name, record_id, record_type, start_date, end_date, limit, offset } = req.query;
    if (!module_name) return res.status(400).json({ error: 'module query parameter is required' });

    const filters = {
      module_name,
      start_date,
      end_date,
      limit : limit  || 100,
      offset: offset || 0,
    };

    // When a specific record is requested, use the optimised reference query
    if (record_id && record_type) {
      const logs = await auditRepository.findByReference(record_id, record_type);
      // Apply date filter in-memory if provided (reference query is already ordered)
      const filtered = logs.filter(l => {
        if (start_date && new Date(l.created_at) < new Date(start_date)) return false;
        if (end_date   && new Date(l.created_at) > new Date(new Date(end_date).setHours(23,59,59,999))) return false;
        return true;
      });
      return res.json({ logs: filtered, total: filtered.length });
    }

    const result = await auditRepository.findAll(filters);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── All events for one entity ─────────────────────────────────────────────────
router.get('/reference/:reference_id/:reference_type', async (req, res) => {
  try {
    const logs = await auditRepository.findByReference(
      req.params.reference_id,
      req.params.reference_type
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
