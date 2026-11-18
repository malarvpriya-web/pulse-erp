// Record-correction tickets (2026-11-11).
//
// Employees no longer change their own records (migration 20261111000001). When
// one spots a mistake on HR > Self Service > My Details they raise a correction
// — an ordinary helpdesk ticket (support_tickets, so it shows in My Tickets)
// with category 'Record correction' and team 'HR Support' or 'Finance'.
//
// It is decided by the people who maintain that data, not by service-desk
// agents: HR (hr:edit) for the employee record, Finance
// (it_declarations:add) for IT declarations / tax regime. They
// see it in the Approval Center (approvals.sources.js `corr`) and close it with
//   POST /servicedesk/corrections/:id/resolve { outcome: 'done'|'declined', note }
// which sets the ticket Resolved / Closed, posts the note on the ticket for the
// employee to read, and notifies them. Nobody resolves their own request.
import pool from '../../config/db.js';
import { can } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import { nextTicketNumber } from '../../shared/docNumber.js';
import { ownEmployeeId } from '../payroll/payrollAccess.js';

export const CORRECTION_CATEGORY = 'Record correction';
// what the employee picks → the ticket team
export const CORRECTION_TEAMS = { HR: 'HR Support', Finance: 'Finance' };
const MAX = 2000;

/** May this caller resolve a correction addressed to `team`? Mirrored in approvals.sources.js. */
export async function canResolveCorrection(req, team) {
  // hr:edit — the HR people (hr, hr_manager, hr_exec, admins) who edit the
  // employee record. employees:edit is held only by hr and the admins.
  if (team === CORRECTION_TEAMS.HR) return can(req, 'hr', 'edit');
  // it_declarations:add — Finance, who enter IT declarations (finance_manager,
  // payroll_admin, admins). NOT payroll:edit: hr / hr_manager hold that too.
  if (team === CORRECTION_TEAMS.Finance) return can(req, 'it_declarations', 'add');
  return false;
}

const clean = (v, max = MAX) => String(v ?? '').trim().slice(0, max);

// The caller's login email — the token's, else the users row (a token minted
// without one must not turn into "no requester" / "not my request").
async function emailOf(req) {
  if (req.user?.email) return String(req.user.email);
  const id = req.user?.userId ?? req.user?.id;
  if (!id) return null;
  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [id]);
  return rows[0]?.email ?? null;
}

// POST /servicedesk/corrections — { to: 'HR'|'Finance', section, field, current_value, correct_value, details }
export async function createCorrection(req, res) {
  try {
    const empId = await ownEmployeeId(req);
    if (empId == null) return res.status(403).json({ error: 'Your login is not linked to an employee record' });
    const team = CORRECTION_TEAMS[req.body?.to];
    if (!team) return res.status(400).json({ error: "Choose who should correct it: 'HR' or 'Finance'" });
    const field = clean(req.body?.field, 120);
    const correct = clean(req.body?.correct_value, 500);
    const details = clean(req.body?.details);
    if (!field) return res.status(400).json({ error: 'Say which detail is wrong' });
    if (!correct && !details) return res.status(400).json({ error: 'Give the correct value or describe the mistake' });
    const section = clean(req.body?.section, 120);
    const current = clean(req.body?.current_value, 500);
    const cid = companyOf(req);
    const { rows: [emp] } = await pool.query(
      `SELECT office_id, COALESCE(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''), name) AS name
         FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int)`, [empId, cid]);
    if (!emp) return res.status(403).json({ error: 'Your login is not linked to an employee record' });

    const title = `Correction: ${field}${emp.office_id ? ` (${emp.office_id})` : ''}`;
    const description = [
      `Employee: ${emp.name}${emp.office_id ? ` (${emp.office_id})` : ''}`,
      section && `Section: ${section}`,
      `Detail: ${field}`,
      current && `Shown now: ${current}`,
      correct && `Should be: ${correct}`,
      details && `Notes: ${details}`,
    ].filter(Boolean).join('\n');
    const ticket_number = await nextTicketNumber();
    const { rows: [t] } = await pool.query(
      `INSERT INTO support_tickets (ticket_number, title, description, category, priority, status, team,
                                    requester_name, requester_email, company_id, ticket_kind, department)
       VALUES ($1,$2,$3,$4,'Medium','Open',$5,$6,$7,$8,'helpdesk',$9) RETURNING *`,
      [ticket_number, title, description, CORRECTION_CATEGORY, team, emp.name, await emailOf(req), cid, req.body.to]);
    logAudit({ userId: req.user?.userId, module: 'service', recordId: t.id, recordType: 'support_ticket', action: 'create', newData: t, req });
    res.status(201).json(t);
  } catch (err) {
    console.error('createCorrection error:', err);
    res.status(500).json({ error: 'The correction request could not be raised' });
  }
}

// POST /servicedesk/corrections/:id/resolve — { outcome: 'done'|'declined', note }
export async function resolveCorrection(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ticket id' });
  const outcome = req.body?.outcome;
  if (!['done', 'declined'].includes(outcome)) return res.status(400).json({ error: "outcome must be 'done' or 'declined'" });
  const note = clean(req.body?.note);
  if (outcome === 'declined' && !note) return res.status(400).json({ error: 'Give the employee a reason' });
  try {
    const cid = companyOf(req);
    const { rows: [t] } = await pool.query(
      `SELECT id, ticket_number, title, team, status, requester_email, company_id FROM support_tickets
        WHERE id = $1 AND category = $2 AND deleted_at IS NULL AND ($3::int IS NULL OR company_id = $3::int)`,
      [id, CORRECTION_CATEGORY, cid]);
    // Anything the caller may not act on answers like a missing id.
    if (!t || !(await canResolveCorrection(req, t.team))) return res.status(404).json({ error: 'Correction request not found' });
    const me = await emailOf(req);
    const mine = t.requester_email && me && t.requester_email.toLowerCase() === me.toLowerCase();
    if (mine) return res.status(403).json({ error: 'Someone else must resolve your own correction request' });
    if (!['Open', 'In Progress'].includes(t.status)) return res.status(409).json({ error: `This request is already ${t.status}` });

    const status = outcome === 'done' ? 'Resolved' : 'Closed';
    const { rows: [u] } = await pool.query(
      `UPDATE support_tickets SET status = $2::varchar, resolved_at = NOW(), closed_at = CASE WHEN $2::varchar = 'Closed' THEN NOW() ELSE closed_at END,
              updated_at = NOW()
        WHERE id = $1 AND status IN ('Open', 'In Progress') RETURNING *`, [t.id, status]);
    if (!u) return res.status(409).json({ error: 'Someone else resolved this request meanwhile' });
    const message = outcome === 'done'
      ? `Corrected.${note ? ` ${note}` : ''}`
      : `Not changed. ${note}`;
    await pool.query(
      `INSERT INTO ticket_conversations (ticket_id, message, is_internal, created_by, created_by_name, channel)
       VALUES ($1, $2, false, $3, $4, 'web')`,
      // created_by references employees(id)
      [t.id, message, (await ownEmployeeId(req)) ?? null, me]);
    await pool.query(
      `INSERT INTO notifications (user_id, notification_type, title, message, module_name, reference_id, link)
       SELECT u.id, 'record_correction', $2, $3, 'service', $4, '/MyEmployeeRecord'
         FROM users u WHERE LOWER(u.email) = LOWER($1) LIMIT 1`,
      [t.requester_email, outcome === 'done' ? 'Your record was corrected' : 'Your correction request was declined',
       `${t.title}: ${message}`, t.id]).catch(() => {});
    logAudit({ userId: req.user?.userId, module: 'service', recordId: t.id, recordType: 'support_ticket', action: outcome === 'done' ? 'resolve' : 'decline',
      oldData: { status: t.status }, newData: { status, note: note || null }, req, company_id: t.company_id });
    res.json(u);
  } catch (err) {
    console.error('resolveCorrection error:', err);
    res.status(500).json({ error: 'The request could not be resolved' });
  }
}

// GET /servicedesk/corrections/mine — the caller's own correction requests, with
// the latest reply from HR / Finance (the note posted when it was resolved).
export async function myCorrections(req, res) {
  try {
    const email = await emailOf(req);
    if (!email) return res.json([]);
    const { rows } = await pool.query(
      `SELECT t.id, t.ticket_number, t.title, t.team, t.status, t.created_at, t.resolved_at,
              (SELECT c.message FROM ticket_conversations c WHERE c.ticket_id = t.id AND c.is_internal = false
                ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reply
         FROM support_tickets t
        WHERE t.category = $1 AND t.deleted_at IS NULL AND LOWER(t.requester_email) = LOWER($2)
          AND ($3::int IS NULL OR t.company_id = $3::int)
        ORDER BY t.created_at DESC LIMIT 50`, [CORRECTION_CATEGORY, email, companyOf(req)]);
    res.json(rows);
  } catch (err) {
    console.error('myCorrections error:', err);
    res.status(500).json({ error: 'Could not load your correction requests' });
  }
}
