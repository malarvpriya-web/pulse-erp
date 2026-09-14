/**
 * dealRegistration.routes.js — partner deal registration.
 *
 * Mounted at /api/sales/deal-registrations.
 *
 * Authorization: reading needs `sales.view`, registering needs `sales.add`,
 * and approving/rejecting additionally needs a manager role, checked in the
 * service so the rule holds however it is called. Every state change is audited
 * with a before image — these are commercial commitments with money attached.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, rolesOf } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import {
  TRANSITIONS, APPROVAL_ROLES, approve, transition,
  findConflict, expireLapsed, partnerPerformance,
} from '../services/dealRegistration.service.js';

const router = express.Router();
const canView = requirePermission('sales', 'view');
const canAdd  = requirePermission('sales', 'add');
const canEdit = requirePermission('sales', 'edit');
const cid = (req) => companyOf(req);
const fail = (res, err) => res.status(500).json({ error: err.message });

function refuse(res, out) {
  switch (out.error) {
    case 'not_found':     return res.status(404).json({ error: 'Registration not found' });
    case 'self_approval': return res.status(403).json({
      error: 'A registration cannot be approved by the person who submitted it' });
    case 'role_required': return res.status(403).json({
      error: `Approving a deal registration requires one of: ${out.roles.join(', ')}`,
      required_roles: out.roles });
    case 'illegal_transition': return res.status(409).json({
      error: `Cannot move a registration from ${out.from} to ${out.to}`,
      from: out.from, to: out.to, allowed: out.allowed });
    case 'conflict': return res.status(409).json({
      error: out.conflict
        ? `${out.conflict.partner_name} already holds an approved registration for this customer until ${String(out.conflict.expires_at).slice(0, 10)}`
        : 'Another approved registration for this customer was created at the same moment',
      conflict: out.conflict });
    default: return res.status(400).json({ error: out.error });
  }
}

// ── list ─────────────────────────────────────────────────────────────────────
router.get('/', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    // Sweep before reading: an approved registration whose window closed
    // yesterday must not still be shown as protecting a customer.
    await expireLapsed(pool, { companyId });

    const params = [companyId];
    let where = 'r.company_id = $1';
    const add = (frag, val) => { params.push(val); where += ` AND ${frag.replace('?', `$${params.length}`)}`; };
    if (req.query.status)     add('r.status = ?', req.query.status);
    if (req.query.partner_id) add('r.partner_id = ?', req.query.partner_id);
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where += ` AND (r.customer_name ILIKE $${params.length} OR r.deal_description ILIKE $${params.length})`;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT r.*, p.name AS partner_name, p.commission_pct,
              e.first_name || ' ' || COALESCE(e.last_name, '') AS approved_by_name,
              (r.status = 'approved' AND r.expires_at IS NOT NULL
                 AND r.expires_at < NOW() + INTERVAL '14 days') AS expiring_soon,
              CASE WHEN r.status = 'approved' AND r.expires_at IS NOT NULL
                   THEN GREATEST(0, EXTRACT(DAY FROM r.expires_at - NOW())::int)
              END AS days_remaining
         FROM partner_deal_registrations r
         JOIN sales_partners p ON p.id = r.partner_id
         LEFT JOIN employees e ON e.id = r.approved_by
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}`,
      params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/summary', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    await expireLapsed(pool, { companyId });
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'submitted')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'approved')::int  AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
              COUNT(*) FILTER (WHERE status = 'expired')::int   AS expired,
              COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE status = 'approved' AND expires_at < NOW() + INTERVAL '14 days')::int
                AS expiring_soon,
              COALESCE(SUM(estimated_value) FILTER (WHERE status = 'approved'), 0) AS protected_value,
              COUNT(*)::int AS total
         FROM partner_deal_registrations WHERE company_id = $1`,
      [companyId]);
    res.json({ ...row, protected_value: Number(row.protected_value) });
  } catch (err) { fail(res, err); }
});

router.get('/partner-performance', canView, async (req, res) => {
  try { res.json(await partnerPerformance(pool, { companyId: cid(req) })); }
  catch (err) { fail(res, err); }
});

/** Check a customer BEFORE registering — the partner-facing "is this free?". */
router.get('/check', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    if (!req.query.customer_name) {
      return res.status(400).json({ error: 'customer_name is required' });
    }
    await expireLapsed(pool, { companyId });
    const conflict = await findConflict(pool, { companyId, customerName: req.query.customer_name });
    res.json({
      available: !conflict,
      // Enough to explain the refusal, without telling one partner the size or
      // the detail of another partner's deal.
      conflict: conflict ? {
        partner_name: conflict.partner_name,
        expires_at: conflict.expires_at,
        registration_number: conflict.registration_number,
      } : null,
    });
  } catch (err) { fail(res, err); }
});

router.get('/:id', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.name AS partner_name, p.commission_pct
         FROM partner_deal_registrations r
         JOIN sales_partners p ON p.id = r.partner_id
        WHERE r.id = $1 AND r.company_id = $2`,
      [req.params.id, cid(req)]);
    if (!rows.length) return res.status(404).json({ error: 'Registration not found' });
    res.json(rows[0]);
  } catch (err) { fail(res, err); }
});

router.get('/:id/events', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ev.id, ev.event, ev.detail, ev.created_at,
              e.first_name || ' ' || COALESCE(e.last_name, '') AS actor_name
         FROM partner_deal_registration_events ev
         LEFT JOIN employees e ON e.id = ev.actor_employee
         JOIN partner_deal_registrations r ON r.id = ev.registration_id
        WHERE ev.registration_id = $1 AND r.company_id = $2
        ORDER BY ev.created_at`,
      [req.params.id, cid(req)]);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

// ── register ─────────────────────────────────────────────────────────────────
router.post('/', canAdd, async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      partner_id, customer_name, customer_id, contact_name, contact_email, contact_phone,
      region, deal_description, estimated_value, expected_close_date, protection_days,
    } = req.body || {};

    if (!partner_id)    return res.status(400).json({ error: 'partner_id is required' });
    if (!customer_name) return res.status(400).json({ error: 'customer_name is required' });
    if (estimated_value != null && !(Number(estimated_value) >= 0)) {
      return res.status(400).json({ error: 'estimated_value must be zero or more' });
    }

    const { rows: [partner] } = await pool.query(
      `SELECT id, name FROM sales_partners
        WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) AND deleted_at IS NULL`,
      [partner_id, companyId]);
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    // Told at submission, not at approval. A partner who learns three days later
    // that the customer was already taken has wasted the three days.
    await expireLapsed(pool, { companyId });
    const conflict = await findConflict(pool, { companyId, customerName: customer_name });

    const employeeId = await employeeOf(req, pool);
    const { rows: [created] } = await pool.query(
      `INSERT INTO partner_deal_registrations
         (company_id, partner_id, customer_name, customer_id, contact_name, contact_email,
          contact_phone, region, deal_description, estimated_value, expected_close_date,
          protection_days, submitted_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, 90),$13,'submitted')
       RETURNING *`,
      [companyId, partner_id, customer_name, customer_id || null, contact_name || null,
       contact_email || null, contact_phone || null, region || null, deal_description || null,
       estimated_value ?? null, expected_close_date || null, protection_days ?? null, employeeId]);

    await pool.query(
      `UPDATE partner_deal_registrations
          SET registration_number = 'DR-' || LPAD(id::text, 5, '0') WHERE id = $1`, [created.id]);

    await pool.query(
      `INSERT INTO partner_deal_registration_events
         (registration_id, company_id, event, detail, actor_employee)
       VALUES ($1,$2,'submitted',$3,$4)`,
      [created.id, companyId, `Registered for ${customer_name} by ${partner.name}`, employeeId]);

    logAudit({ userId: req.user?.userId, module: 'sales', recordId: created.id,
      recordType: 'deal_registration', action: 'create', newData: created, req });

    res.status(201).json({
      ...created,
      registration_number: `DR-${String(created.id).padStart(5, '0')}`,
      warning: conflict
        ? `${conflict.partner_name} already holds an approved registration for this customer until ${String(conflict.expires_at).slice(0, 10)}. This registration cannot be approved while that stands.`
        : undefined,
    });
  } catch (err) { fail(res, err); }
});

// ── decisions ────────────────────────────────────────────────────────────────
router.post('/:id/approve', canEdit, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM partner_deal_registrations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]);

    const out = await approve(pool, {
      id: req.params.id, companyId, employeeId: await employeeOf(req, pool),
      roles: rolesOf(req), protectionDays: req.body?.protection_days,
    });
    if (out.error) return refuse(res, out);

    logAudit({ userId: req.user?.userId, module: 'sales', recordId: out.registration.id,
      recordType: 'deal_registration', action: 'approve', oldData: before,
      newData: out.registration, req });
    res.json(out.registration);
  } catch (err) { fail(res, err); }
});

const move = (to) => async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM partner_deal_registrations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]);

    const out = await transition(pool, {
      id: req.params.id, companyId, to, employeeId: await employeeOf(req, pool),
      roles: rolesOf(req), reason: req.body?.reason,
    });
    if (out.error) return refuse(res, out);

    logAudit({ userId: req.user?.userId, module: 'sales', recordId: out.registration.id,
      recordType: 'deal_registration', action: to, oldData: before,
      newData: out.registration, req });
    res.json(out.registration);
  } catch (err) { fail(res, err); }
};

router.post('/:id/reject',    canEdit, move('rejected'));
router.post('/:id/withdraw',  canEdit, move('withdrawn'));
router.post('/:id/resubmit',  canEdit, move('submitted'));
router.post('/:id/lost',      canEdit, move('lost'));

/**
 * Convert an approved registration into an opportunity.
 *
 * The link is written on BOTH sides — `opportunities.deal_registration_id` and
 * `partner_deal_registrations.opportunity_id` — so the attribution survives
 * whichever record somebody is looking at. Written in one transaction, because a
 * half-linked conversion is a commission argument waiting to happen.
 */
router.post('/:id/convert', canEdit, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const employeeId = await employeeOf(req, pool);
    await client.query('BEGIN');

    const { rows: [reg] } = await client.query(
      `SELECT * FROM partner_deal_registrations
        WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, companyId]);
    if (!reg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Registration not found' }); }
    if (reg.status !== 'approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Only an approved registration can be converted',
        status: reg.status, allowed: TRANSITIONS[reg.status] || [] });
    }

    const { opportunity_id } = req.body || {};
    let oppId = opportunity_id;
    if (oppId) {
      const { rows } = await client.query(
        `SELECT id FROM opportunities WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
        [oppId, companyId]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Opportunity not found' });
      }
    } else {
      // No opportunity_id given: this endpoint LINKS, it does not invent an
      // opportunity. Creating one here would duplicate the pipeline's own
      // creation rules (numbering, stage vocabulary, owner assignment).
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'opportunity_id is required — create the opportunity first, then link it here' });
    }

    await client.query(
      `UPDATE opportunities SET deal_registration_id = $1 WHERE id = $2`, [reg.id, oppId]);
    const { rows: [updated] } = await client.query(
      `UPDATE partner_deal_registrations
          SET status = 'converted', opportunity_id = $2, converted_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [reg.id, oppId]);
    await client.query(
      `INSERT INTO partner_deal_registration_events
         (registration_id, company_id, event, detail, actor_employee)
       VALUES ($1,$2,'converted',$3,$4)`,
      [reg.id, companyId, `Linked to opportunity ${oppId}`, employeeId]);

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'sales', recordId: reg.id,
      recordType: 'deal_registration', action: 'convert', oldData: reg, newData: updated, req });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

router.get('/meta/transitions', canView, (_req, res) =>
  res.json({ transitions: TRANSITIONS, approval_roles: APPROVAL_ROLES }));

export default router;
