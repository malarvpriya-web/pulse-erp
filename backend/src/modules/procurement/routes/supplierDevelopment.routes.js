/**
 * Supplier development routes — the last stage of the supplier loop.
 *
 * Base: /api/v1/supplier-development
 *
 * AUTHORIZATION. `requireProcurement(action, ...alsoAllowRoles)` ORs the
 * role_permissions matrix with named roles, which is how the rest of this module
 * is gated — the matrix stays the single source of truth and the named roles are
 * the documented exceptions. Quality works the programmes that answer NCRs, so
 * qc_manager and qc_engineer are named here for the same reason they are on the
 * NCR/CAPA surface.
 *
 * Closing a plan is `approve`, not `edit`: closing is where effectiveness is
 * recorded against a supplier's name, and it is the judgement, not the typing.
 *
 * As in sourcing.routes.js, no handler swallows a query error into an empty
 * result. A 500 someone can see beats a zero nobody questions.
 */
import express from 'express';
import svc from '../services/supplierDevelopment.service.js';
import { DEVELOPMENT_METHODS } from '../engines/supplierDevelopmentEngine.js';
import { companyOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';

const router = express.Router();

const scopeOf = (req) => req.scope?.company_id ?? companyOf(req);
/** The acting user's users.id — `req.user` is the raw JWT payload, whose field is `userId`. */
const actorUserId = (req) => req.user?.userId ?? req.user?.id ?? null;

const fail = (res, err) => res
  .status(err.status || 500)
  .json({ success: false, error: err.message });

/** The method vocabulary, so the UI never hard-codes a list that can drift. */
router.get('/methods', requireProcurement('view', 'qc_manager', 'qc_engineer'), (req, res) => {
  res.json({ success: true, data: Object.entries(DEVELOPMENT_METHODS).map(([key, label]) => ({ key, label })) });
});

router.get('/', requireProcurement('view', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const data = await svc.list({
      companyId: scopeOf(req),
      vendorId: req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null,
      status: req.query.status || null,
    });
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
});

router.get('/summary', requireProcurement('view', 'qc_manager'), async (req, res) => {
  try {
    res.json({ success: true, data: await svc.summary(scopeOf(req)) });
  } catch (err) { fail(res, err); }
});

/**
 * What this supplier's evidence argues for.
 *
 * ⚠ This RECOMMENDS; it never creates. The buyer opens the plan, and the reason
 * they were shown travels onto it as `trigger_reason`.
 */
router.get('/recommendations/:vendorId', requireProcurement('view', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const data = await svc.recommendFor(parseInt(req.params.vendorId, 10), scopeOf(req));
    res.json({ success: true, data });
  } catch (err) { fail(res, err); }
});

router.get('/:id', requireProcurement('view', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const plan = await svc.getOne(parseInt(req.params.id, 10), scopeOf(req));
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    res.json({ success: true, data: plan });
  } catch (err) { fail(res, err); }
});

router.post('/', requireProcurement('add', 'qc_manager'), async (req, res) => {
  try {
    const plan = await svc.create(req.body, { companyId: scopeOf(req), userId: actorUserId(req) });
    res.status(201).json({ success: true, data: plan });
  } catch (err) { fail(res, err); }
});

router.patch('/:id', requireProcurement('edit', 'qc_manager'), async (req, res) => {
  try {
    const plan = await svc.update(parseInt(req.params.id, 10), req.body, { companyId: scopeOf(req) });
    res.json({ success: true, data: plan });
  } catch (err) { fail(res, err); }
});

/**
 * Close and judge. `effectiveness` is derived from the scorecard at open and at
 * close — the caller cannot supply it, and cannot supply the outcome either.
 */
router.post('/:id/close', requireProcurement('approve', 'qc_manager'), async (req, res) => {
  try {
    const plan = await svc.close(parseInt(req.params.id, 10), {
      status: req.body?.status || 'completed',
      companyId: scopeOf(req),
    });
    res.json({ success: true, data: plan });
  } catch (err) { fail(res, err); }
});

router.post('/:id/actions', requireProcurement('add', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const action = await svc.addAction(parseInt(req.params.id, 10), req.body, { companyId: scopeOf(req) });
    res.status(201).json({ success: true, data: action });
  } catch (err) { fail(res, err); }
});

router.patch('/actions/:actionId', requireProcurement('edit', 'qc_manager', 'qc_engineer'), async (req, res) => {
  try {
    const action = await svc.updateAction(parseInt(req.params.actionId, 10), req.body, { companyId: scopeOf(req) });
    res.json({ success: true, data: action });
  } catch (err) { fail(res, err); }
});

export default router;
