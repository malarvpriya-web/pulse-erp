/**
 * gateAccess.routes.js — Gate Pass & Visitors. MODULE_FEATURE_CONNECTION_MANUAL.md §272.
 *
 * Split out of hr/biometric.routes.js (which keeps devices, punches and the
 * attendance import) when the page was made production-ready on the owner's
 * decisions of 2026-11-12:
 *
 *   · Person passes AND material passes (returnable RGP / non-returnable NRGP),
 *     both on gate_passes; the goods on gate_pass_items.
 *   · Employees request their OWN pass and pre-register their OWN visitors; no
 *     grant needed. The department head (else reporting manager, else HR) is
 *     notified and approves — shared/gatePassApprover.js, the same rule the
 *     Approval Center applies.
 *   · A pending pass and a visitor still expected or inside can be edited.
 *   · The gate records the ACTUAL out and in time; returnable goods are
 *     returned line by line; a pass still out can be closed with a reason.
 *   · Visitor ID numbers are stored masked (last 4) — never in full.
 *   · The host is notified when their visitor arrives.
 *   · Every action is written to access_events: the history panel.
 *
 * Permission: the `gate_access` module (migration 20261112000003).
 *   view     the registers (every pass and visitor of the company)
 *   add      issue a pass for anyone; check a visitor in; pre-register for any host
 *   edit     gate actions (out, in, returns, close), edit / cancel any pass,
 *            check visitors out, edit them, print and record badges, photos
 *   approve  the HR fallback approver
 *   export   CSV
 * Without a grant, a signed-in user with a linked employee sees and acts on
 * their own passes (as holder or requester) and the visitors they host.
 *
 * Effective status is computed in SQL from the stored status and the clock, so
 * the filter, the counts and the rows always agree.
 */
import express from 'express';
import pool from '../../config/db.js';
import { permissionFor } from '../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../shared/scope.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { GP_APPROVER_JOIN, APPROVER_LABEL, approverDecision } from '../../shared/gatePassApprover.js';
import { toCsv, sendCsv } from '../../shared/csv.js';
import { uploadFile, deleteFile } from '../../services/StorageService.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';
import { singleFileUpload } from './internshipUploads.js';
import { blank, listPage, dateRange, positiveIntOrNull } from './listQuery.js';
import { dayRules } from './biometric.routes.js';
import { maskIdNumber } from '../../shared/idMask.js';

const router = express.Router();

/* ─── caller context ──────────────────────────────────────────────── */

const signedIn = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Unauthorized' }));

/** The caller's company, employee and gate_access grants — once per request. */
async function ctxOf(req) {
  if (req._gateCtx) return req._gateCtx;
  const p = await permissionFor(req, 'gate_access').catch(() => null);
  const sec = await permissionFor(req, 'gate_security').catch(() => null);
  const g = {
    view: !!p?.can_view, add: !!p?.can_add, edit: !!p?.can_edit,
    approve: !!p?.can_approve, export: !!p?.can_export,
    // §273: approve or reject a visitor's entry (Security / Gate Desk).
    security: !!sec?.can_approve,
  };
  const employeeId = await employeeOf(req, pool);
  req._gateCtx = { companyId: companyOf(req), employeeId: employeeId ?? null, userId: req.user?.id ?? null, g };
  return req._gateCtx;
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });

/** Display name for an employees alias. */
const EN = (a) => `COALESCE(NULLIF(BTRIM(${a}.name), ''), BTRIM(CONCAT_WS(' ', ${a}.first_name, ${a}.last_name)))`;

/* ─── history and notifications ───────────────────────────────────── */

async function logEvent(db, ctx, entityType, entityId, action, note = null, data = null) {
  await db.query(
    `INSERT INTO access_events (company_id, entity_type, entity_id, action, actor_user_id, actor_employee_id, note, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.companyId, entityType, entityId, action, ctx.userId, ctx.employeeId, note, data ? JSON.stringify(data) : null]);
}

async function eventsOf(entityType, entityId) {
  const { rows } = await pool.query(
    `SELECT ev.id, ev.action, ev.note, ev.data, ev.created_at,
            COALESCE(${EN('e')}, u.name, u.email) AS actor_name
       FROM access_events ev
       LEFT JOIN employees e ON e.id = ev.actor_employee_id
       LEFT JOIN users u ON u.id = ev.actor_user_id
      WHERE ev.entity_type = $1 AND ev.entity_id = $2
      ORDER BY ev.created_at, ev.id`, [entityType, entityId]);
  return rows;
}

/** Active logins of these employees, in this company. */
async function usersOfEmployees(employeeIds, companyId) {
  const ids = [...new Set(employeeIds.filter(x => x != null).map(Number))];
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id FROM users u JOIN employees e ON e.id = u.employee_id
      WHERE u.employee_id = ANY($1::int[]) AND u.is_active = true AND e.deleted_at IS NULL
        AND ($2::int IS NULL OR e.company_id = $2)`, [ids, companyId]);
  return rows.map(r => r.id);
}

/** Active logins whose ROLE grants `module`:approve, in this company. */
async function approverUsers(module, companyId, exceptEmployeeId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id FROM users u
       JOIN employees e ON e.id = u.employee_id AND e.deleted_at IS NULL
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.module = $3 AND rp.can_approve = true
      WHERE u.is_active = true AND ($1::int IS NULL OR e.company_id = $1)
        AND ($2::int IS NULL OR e.id <> $2)`, [companyId, exceptEmployeeId ?? null, module]);
  return rows.map(r => r.id);
}
const hrApproverUsers = (companyId, exceptEmployeeId) => approverUsers('gate_access', companyId, exceptEmployeeId);
/** Security / Gate Desk logins: everyone whose role approves visitor entry. */
const securityUsers = (companyId) => approverUsers('gate_security', companyId, null);

/**
 * In-app notification (the record), then push/email best-effort. Never throws:
 * a notification failure must not fail the action that caused it.
 */
async function notify(userIds, { title, message, link, referenceId, type, companyId, skipUserId }) {
  for (const userId of [...new Set(userIds)].filter(id => id != null && id !== skipUserId)) {
    try {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type, link)
         VALUES ($1, $2, $3, 'gate_access', $4, $5, $6)`,
        [userId, title, message, referenceId ?? null, type, link ?? null]);
      notificationsRepository.dispatchSideEffects({
        user_id: userId, title, message, module_name: 'gate_access', reference_id: referenceId, notification_type: type, company_id: companyId,
      }).catch(() => {});
    } catch (err) {
      console.error('[gate-access] notification failed:', err.message);
    }
  }
}

/* ═══ GATE PASSES ═════════════════════════════════════════════════════
 *
 * Stored status: pending → approved → out → completed;  pending|approved → cancelled.
 * A non-returnable material pass completes when it goes out.
 * Effective (shown) status adds two clock facts:
 *   expired  pending/approved and the window (valid_to) is over — never left
 *   overdue  out, and due back (person: valid_to; material: expected_return_at) is past
 */
const GP_DUE = `(CASE WHEN gp.pass_type = 'material' THEN gp.expected_return_at ELSE gp.valid_to END)`;
const GP_EFFECTIVE = `CASE
    WHEN gp.status = 'cancelled' THEN 'cancelled'
    WHEN gp.status = 'completed' THEN 'completed'
    WHEN gp.status = 'out' AND ${GP_DUE} < NOW() THEN 'overdue'
    WHEN gp.status = 'out' THEN 'out'
    WHEN gp.valid_to IS NOT NULL AND gp.valid_to < NOW() THEN 'expired'
    WHEN gp.status = 'pending' THEN 'pending'
    ELSE 'approved' END`;
export const GP_STATUSES = ['pending', 'approved', 'out', 'overdue', 'expired', 'completed', 'cancelled'];
export const GP_CATEGORIES = ['official', 'personal', 'medical', 'other'];
/** Mark Out may be recorded this many minutes before the window opens. */
const EARLY_OUT_MINUTES = 30;
const MAX_ITEMS = 50;

const GP_SELECT = `
  SELECT gp.*, (${GP_EFFECTIVE}) AS effective_status,
         ${EN('e')} AS employee_name, e.office_id AS emp_code, e.department, e.designation,
         ${EN('a')} AS approved_by_name, ${EN('rq')} AS requested_by_name,
         ${EN('ob')} AS out_by_name, ${EN('ib')} AS in_by_name, ${EN('cb')} AS cancelled_by_name,
         appr.approver_kind, appr.approver_employee_id, appr.approver_name,
         it.items_count, it.qty_total, it.qty_returned,
         vv.name AS visitor_ref_name, vv.company AS visitor_ref_company, vv.pass_number AS visitor_pass_number
    FROM gate_passes gp
    LEFT JOIN employees e  ON e.id  = gp.employee_id AND e.company_id IS NOT DISTINCT FROM gp.company_id
    LEFT JOIN employees a  ON a.id  = gp.approved_by
    LEFT JOIN employees rq ON rq.id = gp.requested_by
    LEFT JOIN employees ob ON ob.id = gp.out_by
    LEFT JOIN employees ib ON ib.id = gp.in_by
    LEFT JOIN employees cb ON cb.id = gp.cancelled_by
    LEFT JOIN visitors vv  ON vv.id = gp.visitor_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS items_count, COALESCE(SUM(quantity), 0)::float AS qty_total,
             COALESCE(SUM(returned_quantity), 0)::float AS qty_returned
        FROM gate_pass_items gi WHERE gi.gate_pass_id = gp.id
    ) it ON true
    ${GP_APPROVER_JOIN}`;

/** Per row: what THIS caller may do — the same rules the routes enforce. */
function decoratePass(r, ctx) {
  const s = r.effective_status;
  const d = approverDecision(r, { callerEmployeeId: ctx.employeeId, hrApprover: ctx.g.approve });
  // A visitor's goods pass names the HOST as employee_id; the host is its
  // approver, so for it only the person who raised it counts as 'own' (§273).
  const own = r.visitor_id != null
    ? sameId(r.requested_by, ctx.employeeId)
    : sameId(r.employee_id, ctx.employeeId) || sameId(r.requested_by, ctx.employeeId);
  const pending = s === 'pending';
  const isOut = s === 'out' || s === 'overdue';
  return {
    ...r,
    is_mine: own,
    can_edit: pending && (ctx.g.edit || own),
    can_approve: pending && d.ok,
    can_reject: pending && d.ok && !own,
    can_cancel: (pending && (ctx.g.edit || own)) || (s === 'approved' && ctx.g.edit),
    can_mark_out: s === 'approved' && ctx.g.edit,
    can_mark_in: isOut && r.pass_type === 'person' && ctx.g.edit,
    can_return: isOut && r.pass_type === 'material' && r.returnable === true && ctx.g.edit,
    can_close: isOut && ctx.g.edit,
    can_print: ['approved', 'out', 'overdue', 'completed'].includes(s) && !(s === 'completed' && !r.approved_at),
    awaiting: pending ? { kind: r.approver_kind, name: r.approver_kind === 'hr' ? 'HR' : r.approver_name, label: APPROVER_LABEL[r.approver_kind] } : null,
    is_visitor_goods: r.visitor_id != null,
    approver_note: pending && !d.ok ? d.reason : null,
  };
}

async function loadPass(id, companyId) {
  const { rows: [row] } = await pool.query(
    `${GP_SELECT} WHERE gp.id = $1 AND ($2::int IS NULL OR gp.company_id = $2)`, [id, companyId]);
  return row ?? null;
}

const itemsOf = async (id, db = pool) => (await db.query(
  `SELECT id, line_no, description, item_code, quantity::float AS quantity, unit,
          returned_quantity::float AS returned_quantity, last_returned_at, remarks
     FROM gate_pass_items WHERE gate_pass_id = $1 ORDER BY line_no, id`, [id])).rows;

/** May the caller SEE this pass? Register holders, the holder/requester, the approver. */
function maySeePass(row, ctx) {
  if (ctx.g.view) return true;
  if (sameId(row.employee_id, ctx.employeeId) || sameId(row.requested_by, ctx.employeeId)) return true;   // incl. a visitor's host
  return approverDecision(row, { callerEmployeeId: ctx.employeeId, hrApprover: ctx.g.approve }).ok;
}

/** Common WHERE for the list and the CSV. Returns { error } or { where, params }. */
function passFilters(req, ctx, { mine }) {
  const range = dateRange(req.query);
  if (range.error) return { error: range.error };
  const status = blank(req.query.status);
  if (status !== null && !GP_STATUSES.includes(String(status))) return { error: `status must be one of ${GP_STATUSES.join(', ')}` };
  const type = blank(req.query.pass_type);
  if (type !== null && !['person', 'material'].includes(String(type))) return { error: "pass_type must be 'person' or 'material'" };
  const category = blank(req.query.category);
  if (category !== null && !GP_CATEGORIES.includes(String(category))) return { error: `category must be one of ${GP_CATEGORIES.join(', ')}` };
  const employeeId = positiveIntOrNull(req.query.employee_id);
  if (Number.isNaN(employeeId)) return { error: 'employee_id must be a positive integer' };

  const params = [ctx.companyId];
  const base = ['($1::int IS NULL OR gp.company_id = $1)'];
  const add = (list, sql, v) => { params.push(v); list.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (mine) add(base, '(gp.employee_id = $? OR gp.requested_by = $?)', ctx.employeeId);
  if (type) add(base, 'gp.pass_type = $?', type);
  const baseLen = params.length;
  const where = [...base];
  if (status)     add(where, `(${GP_EFFECTIVE}) = $?`, status);
  if (category)   add(where, 'gp.category = $?', category);
  if (employeeId) add(where, 'gp.employee_id = $?', employeeId);
  if (range.from) add(where, `COALESCE(gp.valid_to, gp.expected_return_at, 'infinity'::timestamptz)::date >= $?::date`, range.from);
  if (range.to)   add(where, `COALESCE(gp.valid_from, gp.created_at)::date <= $?::date`, range.to);
  const q = blank(req.query.q);
  if (q !== null) {
    add(where, `(gp.pass_number ILIKE $? OR ${EN('e')} ILIKE $? OR e.office_id ILIKE $? OR gp.visitor_name ILIKE $?
                 OR gp.purpose ILIKE $? OR gp.destination ILIKE $? OR gp.vehicle_number ILIKE $? OR gp.carried_by ILIKE $?
                 OR EXISTS (SELECT 1 FROM gate_pass_items gi WHERE gi.gate_pass_id = gp.id
                              AND (gi.description ILIKE $? OR gi.item_code ILIKE $?)))`, `%${String(q).trim()}%`);
  }
  return { where, base, params, baseLen };
}

/** ?scope=mine, or the register for gate_access:view holders. */
function wantsMine(req, ctx) {
  return req.query.scope === 'mine' || !ctx.g.view;
}

/* ─── GET /gate-passes ─── paged list; `counts` per effective status ── */
router.get('/gate-passes', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    const mine = wantsMine(req, ctx);
    if (mine && ctx.employeeId == null) {
      return res.json({ rows: [], total: 0, page: 1, page_size: 25, counts: {}, scope: 'mine',
        message: 'Your login is not linked to an employee record, so you have no gate passes.' });
    }
    const f = passFilters(req, ctx, { mine });
    if (f.error) return fail(res, 400, f.error);
    const { page, pageSize, offset } = listPage(req.query);
    const where = `WHERE ${f.where.join(' AND ')}`;
    // `counts` ignore the status/q/date filters (the chips), but keep the
    // scope and the pass type (the tab): `base` and its params, a prefix.
    const [rowsRes, countRes, countsRes] = await Promise.all([
      pool.query(`${GP_SELECT} ${where} ORDER BY gp.created_at DESC, gp.id DESC LIMIT ${pageSize} OFFSET ${offset}`, f.params),
      pool.query(`SELECT COUNT(*)::int AS n FROM gate_passes gp LEFT JOIN employees e ON e.id = gp.employee_id ${where}`, f.params),
      pool.query(`SELECT (${GP_EFFECTIVE}) AS s, COUNT(*)::int AS n FROM gate_passes gp
                   WHERE ${f.base.join(' AND ')} GROUP BY 1`, f.params.slice(0, f.baseLen)),
    ]);
    const counts = Object.fromEntries(GP_STATUSES.map(s => [s, 0]));
    for (const r of countsRes.rows) counts[r.s] = r.n;
    res.json({
      rows: rowsRes.rows.map(r => decoratePass(r, ctx)),
      total: countRes.rows[0].n, page, page_size: pageSize, counts, scope: mine ? 'mine' : 'all',
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /gate-passes/export ─── CSV of the register (gate_access:export) ── */
router.get('/gate-passes/export', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    if (!ctx.g.export || !ctx.g.view) return fail(res, 403, 'Exporting gate passes needs the Gate Access export permission.');
    const f = passFilters(req, ctx, { mine: false });
    if (f.error) return fail(res, 400, f.error);
    const { tz } = await dayRules(ctx.companyId);
    f.params.push(tz);
    const T = (c) => `TO_CHAR(${c} AT TIME ZONE $${f.params.length}, 'DD Mon YY HH24:MI')`;
    const { rows } = await pool.query(
      `SELECT gp.pass_number, gp.pass_type, gp.category, gp.returnable, ${EN('e')} AS employee, e.office_id AS code, e.department,
              gp.purpose, gp.destination, gp.vehicle_number, gp.carried_by,
              ${T('gp.valid_from')} AS valid_from, ${T('gp.valid_to')} AS valid_to, ${T('gp.expected_return_at')} AS expected_return,
              (${GP_EFFECTIVE}) AS status, ${EN('a')} AS approved_by, ${T('gp.approved_at')} AS approved_at,
              ${T('gp.out_at')} AS out_at, ${T('gp.in_at')} AS in_at,
              (SELECT STRING_AGG(gi.description || ' × ' || TRIM(TO_CHAR(gi.quantity, 'FM999999990.###')) || ' ' || gi.unit, '; ' ORDER BY gi.line_no)
                 FROM gate_pass_items gi WHERE gi.gate_pass_id = gp.id) AS items,
              (SELECT SUM(gi.quantity) FROM gate_pass_items gi WHERE gi.gate_pass_id = gp.id) AS qty_out,
              (SELECT SUM(gi.returned_quantity) FROM gate_pass_items gi WHERE gi.gate_pass_id = gp.id) AS qty_returned,
              gp.close_reason, gp.cancel_reason
         FROM gate_passes gp
         LEFT JOIN employees e ON e.id = gp.employee_id AND e.company_id IS NOT DISTINCT FROM gp.company_id
         LEFT JOIN employees a ON a.id = gp.approved_by
        WHERE ${f.where.join(' AND ')}
        ORDER BY gp.created_at DESC, gp.id DESC LIMIT 5000`, f.params);
    const header = ['Pass No.', 'Type', 'Category', 'Goods', 'Employee', 'Code', 'Department', 'Reason', 'Destination', 'Vehicle',
      'Carried by', 'Valid from', 'Valid to', 'Due back', 'Status', 'Approved by', 'Approved at', 'Out at', 'In at',
      'Items', 'Qty out', 'Qty returned', 'Close reason', 'Cancel reason'];
    const out = rows.map(r => [r.pass_number, r.pass_type === 'material' ? 'Material' : 'Person', r.category ?? '',
      r.pass_type === 'material' ? (r.returnable ? 'Returnable' : 'Non-returnable') : '', r.employee, r.code, r.department,
      r.purpose, r.destination, r.vehicle_number, r.carried_by, r.valid_from, r.valid_to, r.expected_return, r.status,
      r.approved_by, r.approved_at, r.out_at, r.in_at, r.items, r.qty_out, r.qty_returned, r.close_reason, r.cancel_reason]
      .map(v => v ?? ''));
    sendCsv(res, `gate-passes-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(header, out));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /gate-passes/:id ─── one pass, its goods and its history ── */
router.get('/gate-passes/:id', signedIn, async (req, res) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return fail(res, 404, 'Gate pass not found');
  try {
    const ctx = await ctxOf(req);
    const row = await loadPass(id, ctx.companyId);
    if (!row || !maySeePass(row, ctx)) return fail(res, 404, 'Gate pass not found');
    res.json({ ...decoratePass(row, ctx), items: await itemsOf(id), events: await eventsOf('gate_pass', id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── validation ──────────────────────────────────────────────────── */

const text = (v) => (blank(v) === null ? null : String(v).trim());
const isBool = (v) => v === true || v === false || v === 'true' || v === 'false';
const toBool = (v) => v === true || v === 'true';

function parseInstant(errors, field, value) {
  if (value === null) return null;
  const t = new Date(value);
  if (isNaN(t.getTime())) { errors.push(`${field} must be a valid date/time`); return null; }
  return t;
}

/**
 * Validate a gate-pass payload (create, or the full payload of an edit).
 * Returns { errors, value }.
 */
export function validateGatePass(body, { now = new Date() } = {}) {
  const errors = [];
  const passType = text(body.pass_type) ?? 'person';
  if (!['person', 'material'].includes(passType)) errors.push("pass_type must be 'person' or 'material'");
  const purpose = text(body.purpose);
  if (purpose === null) errors.push(passType === 'material' ? 'Say why the goods are leaving' : 'Give the reason for the pass');
  else if (purpose.length > 1000) errors.push('The reason must be 1000 characters or fewer');

  const employeeRaw = blank(body.employee_id);
  if (employeeRaw !== null && (!/^\d+$/.test(String(employeeRaw).trim()) || Number(employeeRaw) < 1)) {
    errors.push('employee_id must be a positive integer');
  }
  const validFrom = parseInstant(errors, 'Valid from', blank(body.valid_from));
  const validTo = parseInstant(errors, 'Valid to', blank(body.valid_to));
  if (validFrom && validTo && validTo <= validFrom) errors.push('Valid to must be after valid from');
  else if (validTo && validTo <= now) errors.push('Valid to is already in the past — the pass would be created expired');

  const v = {
    pass_type: passType, purpose, employee_id: employeeRaw === null ? null : Number(employeeRaw),
    valid_from: validFrom, valid_to: validTo, category: null, returnable: null, expected_return_at: null,
    vehicle_number: text(body.vehicle_number), carried_by: text(body.carried_by), destination: text(body.destination), items: [],
  };
  for (const [field, label, max] of [['vehicle_number', 'Vehicle number', 30], ['carried_by', 'Carried by', 200], ['destination', 'Destination', 300]]) {
    if (v[field] && v[field].length > max) errors.push(`${label} must be ${max} characters or fewer`);
  }
  if (v.vehicle_number) v.vehicle_number = v.vehicle_number.toUpperCase();

  if (passType === 'person') {
    const category = text(body.category);
    if (category === null) errors.push('Choose the type of pass (official, personal, medical or other)');
    else if (!GP_CATEGORIES.includes(category)) errors.push(`category must be one of ${GP_CATEGORIES.join(', ')}`);
    v.category = category;
    if (!validFrom) errors.push('Enter when the employee leaves (Valid from)');
    if (!validTo) errors.push('Enter when the employee is due back (Valid to)');
  }

  if (passType === 'material') {
    if (!isBool(body.returnable)) errors.push('Say whether the goods are coming back (returnable or non-returnable)');
    v.returnable = toBool(body.returnable);
    if (v.destination === null) errors.push('Enter where the goods are going (destination)');
    if (v.returnable) {
      const due = parseInstant(errors, 'Expected return', blank(body.expected_return_at));
      if (!due) errors.push('Enter when returnable goods are due back');
      else if (due <= now) errors.push('Expected return must be in the future');
      else if (validFrom && due <= validFrom) errors.push('Expected return must be after the goods leave');
      v.expected_return_at = due;
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) errors.push('Add at least one item');
    if (items.length > MAX_ITEMS) errors.push(`A pass can list at most ${MAX_ITEMS} items`);
    items.slice(0, MAX_ITEMS).forEach((it, i) => {
      const n = i + 1;
      const description = text(it?.description);
      const qty = Number(it?.quantity);
      const unit = text(it?.unit) ?? 'Nos';
      const code = text(it?.item_code);
      const remarks = text(it?.remarks);
      if (description === null) errors.push(`Item ${n}: describe the item`);
      else if (description.length > 300) errors.push(`Item ${n}: the description must be 300 characters or fewer`);
      if (!Number.isFinite(qty) || qty <= 0) errors.push(`Item ${n}: quantity must be more than 0`);
      else if (qty > 1e9 || Math.round(qty * 1000) !== qty * 1000) errors.push(`Item ${n}: quantity can have at most 3 decimals`);
      if (unit.length > 20) errors.push(`Item ${n}: unit must be 20 characters or fewer`);
      if (code && code.length > 100) errors.push(`Item ${n}: item code must be 100 characters or fewer`);
      if (remarks && remarks.length > 500) errors.push(`Item ${n}: remarks must be 500 characters or fewer`);
      v.items.push({ description, quantity: qty, unit, item_code: code, remarks });
    });
  }
  return { errors, value: v };
}

/** The pass holder: a current employee of the caller's company. */
async function checkHolder(db, employeeId, companyId) {
  const { rows: [e] } = await db.query(
    `SELECT id, ${EN('employees')} AS name FROM employees
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL AND ${isCurrentSql('status')}`,
    [employeeId, companyId]);
  return e ?? null;
}

async function nextPassNumber(db, passType) {
  const seq = passType === 'material' ? 'seq_material_gate_pass' : 'seq_gate_pass';
  const { rows: [{ n }] } = await db.query(`SELECT nextval($1)::int AS n`, [seq]);
  return `${passType === 'material' ? 'MGP' : 'GP'}-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
}

async function writeItems(db, passId, companyId, items) {
  await db.query('DELETE FROM gate_pass_items WHERE gate_pass_id = $1', [passId]);
  let line = 0;
  for (const it of items) {
    line += 1;
    await db.query(
      `INSERT INTO gate_pass_items (gate_pass_id, company_id, line_no, description, item_code, quantity, unit, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [passId, companyId, line, it.description, it.item_code, it.quantity, it.unit, it.remarks]);
  }
}

/** Tell whoever must approve this pending pass. */
async function notifyApprover(row, ctx) {
  const holder = row.employee_name || 'An employee';
  const what = row.visitor_id != null ? `Goods leaving with your visitor ${row.visitor_ref_name || ''}`.trim()
    : row.pass_type === 'material'
      ? `${row.returnable ? 'Returnable' : 'Non-returnable'} material pass`
      : 'Gate pass';
  const users = row.approver_kind === 'hr'
    ? await hrApproverUsers(ctx.companyId, row.employee_id)
    : await usersOfEmployees([row.approver_employee_id], ctx.companyId);
  await notify(users, {
    title: `${what} waiting for your approval`,
    message: `${row.pass_number} · ${holder} · ${row.purpose}`,
    link: '/ApprovalCenter', referenceId: row.id, type: 'gate_pass_approval', companyId: ctx.companyId, skipUserId: ctx.userId,
  });
}

/** Tell the holder (and a different requester) what happened to their pass. */
async function notifyHolder(row, ctx, title, message) {
  const users = await usersOfEmployees([row.employee_id, row.requested_by], ctx.companyId);
  await notify(users, { title, message, link: '/MyGatePasses', referenceId: row.id, type: 'gate_pass', companyId: ctx.companyId, skipUserId: ctx.userId });
}

/* ─── POST /gate-passes ───────────────────────────────────────────────
 * gate_access:add issues a pass for any current employee. Anyone else signed
 * in with a linked employee requests their OWN pass (employee_id is forced to
 * theirs). Numbered at creation: GP-YYYY-00001 (person), MGP-YYYY-00001
 * (material). The approver is notified.
 *
 * §273 — `visitor_id`: goods a VISITOR takes out. Material only; the visitor
 * must be inside and have a host, who becomes the pass's employee and its
 * approver. Raised by the host → approved at once (the host IS the approval);
 * raised by the gate desk (gate_access:add) → pending, host notified. Security
 * then releases it at the gate (Mark out / Dispatch). */
router.post('/gate-passes', signedIn, async (req, res) => {
  const ctx = await ctxOf(req).catch(() => null);
  if (!ctx) return fail(res, 500, 'Could not read your permissions');
  const visitorId = positiveIntOrNull(req.body?.visitor_id);
  if (Number.isNaN(visitorId)) return fail(res, 400, 'visitor_id must be a positive integer');
  const { errors, value: v } = validateGatePass(req.body ?? {});
  let visitor = null;
  let hostRaised = false;
  if (visitorId) {
    visitor = await loadVisitor(visitorId, ctx);
    if (!visitor || !maySeeVisitor(visitor, ctx)) return fail(res, 404, 'Visitor not found');
    if (v.pass_type !== 'material') errors.push('A visitor can only be given a goods (material) pass');
    if (visitor.effective_status !== 'inside') return fail(res, 409, 'Goods can be passed out only for a visitor who is inside.');
    if (visitor.host_employee_id == null) return fail(res, 409, 'This visitor has no host. Set the host first — the host approves goods leaving with a visitor.');
    hostRaised = sameId(visitor.host_employee_id, ctx.employeeId);
    if (!hostRaised && !ctx.g.add) return fail(res, 403, 'Only the visitor\'s host or the gate desk can raise a goods pass for this visitor.');
    v.employee_id = visitor.host_employee_id;
    if (!v.carried_by) v.carried_by = `${visitor.name}${visitor.company ? ` (${visitor.company})` : ''}`.slice(0, 200);
  } else if (!ctx.g.add) {
    if (ctx.employeeId == null) return fail(res, 403, 'Your login is not linked to an employee record, so you cannot request a gate pass.');
    if (v.employee_id != null && !sameId(v.employee_id, ctx.employeeId)) {
      return fail(res, 403, 'You can request a gate pass only for yourself.');
    }
    v.employee_id = ctx.employeeId;
  } else if (v.employee_id == null) {
    if (ctx.employeeId == null) errors.push('Choose the employee this pass is for');
    else v.employee_id = ctx.employeeId;
  }
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const client = await pool.connect();
  let id;
  try {
    const holder = await checkHolder(client, v.employee_id, ctx.companyId);
    if (!holder) return fail(res, 404, visitor ? 'The visitor\'s host is no longer a current employee' : 'Employee not found, or no longer a current employee');
    await client.query('BEGIN');
    const number = await nextPassNumber(client, v.pass_type);
    const { rows: [row] } = await client.query(
      `INSERT INTO gate_passes (employee_id, pass_type, category, purpose, valid_from, valid_to, returnable, expected_return_at,
                                vehicle_number, carried_by, destination, requested_by, created_by_user_id, pass_number,
                                status, approved_by, approved_at, visitor_id, company_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW()) RETURNING id`,
      [v.employee_id, v.pass_type, v.category, v.purpose, v.valid_from, v.valid_to, v.returnable, v.expected_return_at,
        v.vehicle_number, v.carried_by, v.destination, ctx.employeeId, ctx.userId, number,
        hostRaised ? 'approved' : 'pending', hostRaised ? ctx.employeeId : null, hostRaised ? new Date() : null,
        visitorId, ctx.companyId]);
    id = row.id;
    if (v.pass_type === 'material') await writeItems(client, id, ctx.companyId, v.items);
    await logEvent(client, ctx, 'gate_pass', id, 'created', null,
      visitor ? { visitor_id: visitor.id, visitor_name: visitor.name }
        : sameId(v.employee_id, ctx.employeeId) ? null : { for_employee_id: v.employee_id });
    if (hostRaised) await logEvent(client, ctx, 'gate_pass', id, 'approved', 'Raised by the visitor\'s host');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(res, 500, err.message);
  } finally { client.release(); }

  try {
    const row = await loadPass(id, ctx.companyId);
    if (visitor) {
      if (!hostRaised) await notifyApprover(row, ctx);
      await logEvent(pool, ctx, 'visitor', visitor.id, 'goods_pass', `${row.pass_number}${hostRaised ? ' (approved by host)' : ' — waiting for the host'}`);
    } else {
      await notifyApprover(row, ctx);
      if (!sameId(row.employee_id, ctx.employeeId)) {
        await notifyHolder(row, ctx, 'A gate pass was raised for you', `${row.pass_number} · ${row.purpose} — waiting for approval`);
      }
    }
    res.status(201).json({ ...decoratePass(row, ctx), items: await itemsOf(id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /gate-passes/:id ─── edit a PENDING pass ────────────────────
 * The holder or requester, or gate_access:edit. Only gate_access:edit may move
 * the pass to another employee. The type cannot change (it is in the number). */
router.put('/gate-passes/:id', signedIn, async (req, res) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return fail(res, 404, 'Gate pass not found');
  try {
    const ctx = await ctxOf(req);
    const row = await loadPass(id, ctx.companyId);
    if (!row || !maySeePass(row, ctx)) return fail(res, 404, 'Gate pass not found');
    const cur = decoratePass(row, ctx);
    if (!cur.can_edit) {
      return fail(res, row.effective_status === 'pending' ? 403 : 409,
        row.effective_status === 'pending' ? 'Only the requester or the gate desk can edit this pass.'
          : `This pass is ${row.effective_status} and can no longer be edited.`, { current_status: row.effective_status });
    }
    const body = { ...req.body, pass_type: row.pass_type };
    const { errors, value: v } = validateGatePass(body);
    if (v.employee_id == null) v.employee_id = row.employee_id;
    if (row.visitor_id != null) v.employee_id = row.employee_id;   // a visitor's goods stay with the host (§273)
    if (!sameId(v.employee_id, row.employee_id) && !ctx.g.edit) errors.push('Only the gate desk can move a pass to another employee');
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    if (!sameId(v.employee_id, row.employee_id) && !(await checkHolder(pool, v.employee_id, ctx.companyId))) {
      return fail(res, 404, 'Employee not found, or no longer a current employee');
    }
    const FIELDS = ['employee_id', 'category', 'purpose', 'valid_from', 'valid_to', 'returnable', 'expected_return_at', 'vehicle_number', 'carried_by', 'destination'];
    const norm = (x) => (x instanceof Date ? x.toISOString() : x == null ? null : String(x));
    const changed = FIELDS.filter(f => norm(v[f]) !== norm(row[f] instanceof Date ? row[f] : row[f]));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE gate_passes SET employee_id=$3, category=$4, purpose=$5, valid_from=$6, valid_to=$7, returnable=$8,
                expected_return_at=$9, vehicle_number=$10, carried_by=$11, destination=$12, updated_at=NOW()
          WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) AND status='pending'`,
        [id, ctx.companyId, v.employee_id, v.category, v.purpose, v.valid_from, v.valid_to, v.returnable,
          v.expected_return_at, v.vehicle_number, v.carried_by, v.destination]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This pass was decided while you were editing it.'); }
      if (row.pass_type === 'material') {
        const before = await itemsOf(id, client);
        const same = before.length === v.items.length && before.every((b, i) =>
          b.description === v.items[i].description && b.quantity === v.items[i].quantity && b.unit === v.items[i].unit
          && (b.item_code ?? null) === v.items[i].item_code && (b.remarks ?? null) === v.items[i].remarks);
        if (!same) { await writeItems(client, id, ctx.companyId, v.items); changed.push('items'); }
      }
      await logEvent(client, ctx, 'gate_pass', id, 'edited', null, { fields: changed });
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const after = await loadPass(id, ctx.companyId);
    if (!sameId(after.approver_employee_id, row.approver_employee_id) || after.approver_kind !== row.approver_kind) {
      await notifyApprover(after, ctx);
    }
    res.json({ ...decoratePass(after, ctx), items: await itemsOf(id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/**
 * A conditional transition: UPDATE only when the pass is in an allowed state;
 * otherwise say which state it is in (409) — or 404 when it is not the caller's.
 */
async function transition(req, res, ctx, row, { setSql, setParams = [], allowedSql, refuse, event, note, data, after }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE gate_passes gp SET ${setSql}, updated_at = NOW()
        WHERE gp.id = $1 AND ($2::int IS NULL OR gp.company_id = $2) AND (${allowedSql}) RETURNING gp.id`,
      [row.id, ctx.companyId, ...setParams]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      const fresh = await loadPass(row.id, ctx.companyId);
      return fail(res, 409, refuse(fresh?.effective_status ?? row.effective_status, fresh ?? row), { current_status: fresh?.effective_status });
    }
    await logEvent(client, ctx, 'gate_pass', row.id, event, note ?? null, data ?? null);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(res, 500, err.message);
  } finally { client.release(); }
  const fresh = await loadPass(row.id, ctx.companyId);
  if (after) await after(fresh).catch(err => console.error('[gate-access] after-transition:', err.message));
  return res.json({ ...decoratePass(fresh, ctx), items: await itemsOf(row.id) });
}

/** Load the pass for an action, or answer 404. */
async function passForAction(req, res) {
  const id = positiveIntOrNull(req.params.id);
  if (!id) { fail(res, 404, 'Gate pass not found'); return null; }
  const ctx = await ctxOf(req);
  const row = await loadPass(id, ctx.companyId);
  if (!row || !maySeePass(row, ctx)) { fail(res, 404, 'Gate pass not found'); return null; }
  return { ctx, row };
}

const fmtWhen = (d, tz = 'Asia/Kolkata') => (d ? new Date(d).toLocaleString('en-IN', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

/* ─── PUT /gate-passes/:id/approve ─── the designated approver only ── */
router.put('/gate-passes/:id/approve', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    const d = approverDecision(row, { callerEmployeeId: ctx.employeeId, hrApprover: ctx.g.approve });
    if (!d.ok) {
      return res.status(403).json({ code: 'NOT_THE_APPROVER', message: d.reason,
        approver: { kind: row.approver_kind, employee_id: row.approver_employee_id, name: row.approver_name } });
    }
    return transition(req, res, ctx, row, {
      setSql: `status = 'approved', approved_by = $3, approved_at = NOW()`,
      setParams: [ctx.employeeId],
      allowedSql: `gp.status = 'pending' AND (gp.valid_to IS NULL OR gp.valid_to > NOW())`,
      refuse: (s) => `This pass is ${s} and cannot be approved.`,
      event: 'approved', note: blank(req.body?.comment) ? String(req.body.comment).trim().slice(0, 500) : null,
      after: (p) => notifyHolder(p, ctx, `Gate pass ${p.pass_number} approved`,
        `${p.purpose}${p.valid_from ? ` · from ${fmtWhen(p.valid_from)}` : ''} — show it at the gate`),
    });
  } catch (err) { return fail(res, 500, err.message); }
});

/* ─── PUT /gate-passes/:id/cancel ─────────────────────────────────────
 *   pending   the approver (= reject), the holder/requester (= withdraw), or gate_access:edit
 *   approved  gate_access:edit only (never after it went out — close it instead)
 * A reason is always required. */
router.put('/gate-passes/:id/cancel', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    const cur = decoratePass(row, ctx);
    const rejecting = row.status === 'pending' && cur.can_reject;
    if (!cur.can_cancel && !rejecting) {
      if (['out', 'overdue', 'completed', 'cancelled', 'expired'].includes(row.effective_status)) {
        return fail(res, 409, row.effective_status === 'out' || row.effective_status === 'overdue'
          ? 'This pass is already out. Record the return or close it instead.'
          : `This pass is ${row.effective_status} and cannot be cancelled.`, { current_status: row.effective_status });
      }
      return res.status(403).json({ code: 'NOT_THE_APPROVER',
        message: row.status === 'pending' ? (cur.approver_note || 'You cannot cancel this pass.') : 'Only the gate desk can cancel a pass once it is approved.' });
    }
    const reason = text(req.body?.reason);
    if (reason === null) return fail(res, 400, 'Give a reason');
    if (reason.length > 500) return fail(res, 400, 'The reason must be 500 characters or fewer');
    const own = cur.is_mine;
    const action = rejecting && !own ? 'rejected' : own && row.status === 'pending' ? 'withdrawn' : 'cancelled';
    return transition(req, res, ctx, row, {
      setSql: `status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3, cancel_reason = $4`,
      setParams: [ctx.employeeId, reason],
      allowedSql: `gp.status IN ('pending', 'approved') AND (gp.valid_to IS NULL OR gp.valid_to > NOW())`,
      refuse: (s) => `This pass is ${s} and cannot be cancelled.`,
      event: action, note: reason,
      after: (p) => (own ? Promise.resolve() : notifyHolder(p, ctx,
        `Gate pass ${p.pass_number} ${action === 'rejected' ? 'rejected' : 'cancelled'}`, reason)),
    });
  } catch (err) { return fail(res, 500, err.message); }
});

const needsGateEdit = (res, ctx) => {
  if (ctx.g.edit) return false;
  fail(res, 403, 'Only the gate desk (Gate Access edit permission) can record movements at the gate.');
  return true;
};

/* ─── PUT /gate-passes/:id/out ─── the gate records the ACTUAL exit ───
 * Approved, not expired, and not more than 30 minutes before the window
 * opens. A non-returnable material pass is complete once the goods are out. */
router.put('/gate-passes/:id/out', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    if (needsGateEdit(res, ctx)) return undefined;
    const vehicle = text(req.body?.vehicle_number);
    if (vehicle && vehicle.length > 30) return fail(res, 400, 'Vehicle number must be 30 characters or fewer');
    const finalOut = row.pass_type === 'material' && row.returnable === false;
    return transition(req, res, ctx, row, {
      setSql: finalOut
        ? `status = 'completed', out_at = NOW(), out_by = $3, completed_at = NOW(), completed_by = $3, vehicle_number = COALESCE($4, gp.vehicle_number)`
        : `status = 'out', out_at = NOW(), out_by = $3, vehicle_number = COALESCE($4, gp.vehicle_number)`,
      setParams: [ctx.employeeId, vehicle ? vehicle.toUpperCase() : null],
      allowedSql: `gp.status = 'approved' AND (gp.valid_to IS NULL OR gp.valid_to > NOW())
                   AND (gp.valid_from IS NULL OR gp.valid_from <= NOW() + INTERVAL '${EARLY_OUT_MINUTES} minutes')`,
      refuse: (s, p) => (s === 'approved' && p.valid_from
        ? `This pass starts at ${fmtWhen(p.valid_from)}; the gate can record it from ${EARLY_OUT_MINUTES} minutes before.`
        : s === 'pending' ? 'This pass has not been approved yet.' : `This pass is ${s} and cannot go out.`),
      event: finalOut ? 'dispatched' : 'out', note: text(req.body?.note),
      data: vehicle ? { vehicle_number: vehicle.toUpperCase() } : null,
    });
  } catch (err) { return fail(res, 500, err.message); }
});

/* ─── PUT /gate-passes/:id/in ─── a person pass: back through the gate ── */
router.put('/gate-passes/:id/in', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    if (needsGateEdit(res, ctx)) return undefined;
    if (row.pass_type !== 'person') return fail(res, 409, 'Material passes are closed by recording the returned items.');
    return transition(req, res, ctx, row, {
      setSql: `status = 'completed', in_at = NOW(), in_by = $3, completed_at = NOW(), completed_by = $3`,
      setParams: [ctx.employeeId],
      allowedSql: `gp.status = 'out' AND gp.pass_type = 'person'`,
      refuse: (s) => `This pass is ${s}; only a pass that is out can be marked back in.`,
      event: 'returned', note: text(req.body?.note),
    });
  } catch (err) { return fail(res, 500, err.message); }
});

/* ─── PUT /gate-passes/:id/return ─── returnable goods back, line by line ──
 * body.items: [{ item_id, quantity }]. Partial returns accumulate; the pass
 * completes when every line is fully back. */
router.put('/gate-passes/:id/return', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    if (needsGateEdit(res, ctx)) return undefined;
    if (row.pass_type !== 'material' || row.returnable !== true) return fail(res, 409, 'Only a returnable material pass records returned items.');
    const lines = Array.isArray(req.body?.items) ? req.body.items : [];
    const wanted = lines.map(l => ({ item_id: Number(l?.item_id), quantity: Number(l?.quantity) })).filter(l => l.quantity !== 0);
    if (!wanted.length) return fail(res, 400, 'Enter the quantity returned for at least one item');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [locked] } = await client.query(
        `SELECT status FROM gate_passes WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`, [row.id, ctx.companyId]);
      if (!locked || locked.status !== 'out') {
        await client.query('ROLLBACK');
        return fail(res, 409, `This pass is ${row.effective_status}; returns can be recorded only while the goods are out.`);
      }
      const items = await itemsOf(row.id, client);
      const errors = [];
      const applied = [];
      for (const w of wanted) {
        const it = items.find(i => i.id === w.item_id);
        if (!it) { errors.push(`Item ${w.item_id} is not on this pass`); continue; }
        const open = Math.round((it.quantity - it.returned_quantity) * 1000) / 1000;
        if (!Number.isFinite(w.quantity) || w.quantity < 0) errors.push(`${it.description}: quantity must be more than 0`);
        else if (Math.round(w.quantity * 1000) !== w.quantity * 1000) errors.push(`${it.description}: at most 3 decimals`);
        else if (w.quantity > open) errors.push(`${it.description}: only ${open} ${it.unit} still out`);
        else applied.push({ ...w, description: it.description, unit: it.unit });
      }
      if (errors.length) { await client.query('ROLLBACK'); return res.status(400).json({ message: errors[0], errors }); }
      for (const a of applied) {
        await client.query(
          `UPDATE gate_pass_items SET returned_quantity = returned_quantity + $2, last_returned_at = NOW() WHERE id = $1`,
          [a.item_id, a.quantity]);
      }
      const { rows: [{ open }] } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE returned_quantity < quantity)::int AS open FROM gate_pass_items WHERE gate_pass_id = $1`, [row.id]);
      if (open === 0) {
        await client.query(
          `UPDATE gate_passes SET status = 'completed', in_at = NOW(), in_by = $2, completed_at = NOW(), completed_by = $2, updated_at = NOW()
            WHERE id = $1`, [row.id, ctx.employeeId]);
      } else {
        await client.query(`UPDATE gate_passes SET updated_at = NOW() WHERE id = $1`, [row.id]);
      }
      await logEvent(client, ctx, 'gate_pass', row.id, open === 0 ? 'all_returned' : 'items_returned', text(req.body?.note),
        { items: applied.map(a => ({ item_id: a.item_id, description: a.description, quantity: a.quantity, unit: a.unit })) });
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const fresh = await loadPass(row.id, ctx.companyId);
    res.json({ ...decoratePass(fresh, ctx), items: await itemsOf(row.id) });
  } catch (err) { return fail(res, 500, err.message); }
});

/* ─── PUT /gate-passes/:id/close ─── a pass still out, closed with a reason ──
 * The person is not coming back today, or returnable goods were consumed,
 * sold or lost. What did come back stays recorded. */
router.put('/gate-passes/:id/close', signedIn, async (req, res) => {
  try {
    const got = await passForAction(req, res); if (!got) return undefined;
    const { ctx, row } = got;
    if (needsGateEdit(res, ctx)) return undefined;
    const reason = text(req.body?.reason);
    if (reason === null) return fail(res, 400, 'Give a reason for closing the pass');
    if (reason.length > 500) return fail(res, 400, 'The reason must be 500 characters or fewer');
    return transition(req, res, ctx, row, {
      setSql: `status = 'completed', close_reason = $4, completed_at = NOW(), completed_by = $3`,
      setParams: [ctx.employeeId, reason],
      allowedSql: `gp.status = 'out'`,
      refuse: (s) => `This pass is ${s}; only a pass that is out can be closed.`,
      event: 'closed', note: reason,
      after: (p) => notifyHolder(p, ctx, `Gate pass ${p.pass_number} closed`, reason),
    });
  } catch (err) { return fail(res, 500, err.message); }
});

/* ═══ VISITORS ════════════════════════════════════════════════════════
 *
 * §273 — security approves entry (gate_security:approve):
 *   pending_approval → approved (visitor pass VP-YYYY-00001) → inside → checked_out
 *   pending_approval → rejected (reason)      pending/approved → cancelled
 * no_show  pending/approved and the expected day has passed (still approvable / checkable-in)
 * overstay an inside visitor who checked in on an earlier day (a flag)
 * A walk-in is registered pending (expected now); a security user who also
 * holds gate_access:add can approve and check in in one step.
 * A visitor with an open goods pass (pending or approved, not yet released)
 * cannot check out.
 */
export const ID_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Driving Licence', 'Voter ID', 'Other'];
const ID_RULES = {
  Aadhaar: [/^\d{12}$/, 'Aadhaar must be 12 digits'],
  PAN: [/^[A-Z]{5}\d{4}[A-Z]$/, 'PAN must look like ABCDE1234F'],
  Passport: [/^[A-Z][0-9]{7}$/, 'Passport number must be a letter and 7 digits'],
  'Driving Licence': [/^[A-Z0-9]{8,20}$/, 'Driving licence number must be 8–20 letters or digits'],
  'Voter ID': [/^[A-Z]{3}\d{7}$/, 'Voter ID must look like ABC1234567'],
  Other: [/^[A-Z0-9/]{4,30}$/, 'ID number must be 4–30 letters or digits'],
};
const LEGACY_ID_TYPES = { DL: 'Driving Licence' };
export const VISITOR_STATUSES = ['pending_approval', 'approved', 'inside', 'checked_out', 'no_show', 'rejected', 'cancelled', 'overstay'];
const PHONE_SHAPE = /^\+?[0-9][0-9\s\-()]*$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const phoneDigits = (v) => String(v).replace(/\D/g, '');

/** $tz is the company zone bound at position `tzRef`. */
const V_EFFECTIVE = (tzRef) => `CASE
    WHEN v.cancelled_at IS NOT NULL THEN 'cancelled'
    WHEN v.check_out_time IS NOT NULL THEN 'checked_out'
    WHEN v.check_in_time IS NOT NULL THEN 'inside'
    WHEN v.rejected_at IS NOT NULL THEN 'rejected'
    WHEN (v.expected_at AT TIME ZONE ${tzRef})::date < (NOW() AT TIME ZONE ${tzRef})::date THEN 'no_show'
    WHEN v.approved_at IS NOT NULL THEN 'approved'
    ELSE 'pending_approval' END`;
const V_OVERSTAY = (tzRef) => `(v.check_in_time IS NOT NULL AND v.check_out_time IS NULL AND v.cancelled_at IS NULL
    AND (v.check_in_time AT TIME ZONE ${tzRef})::date < (NOW() AT TIME ZONE ${tzRef})::date)`;

const V_SELECT = (tzRef) => `
  SELECT v.*, (${V_EFFECTIVE(tzRef)}) AS effective_status, ${V_OVERSTAY(tzRef)} AS overstay,
         ${EN('e')} AS host_name, e.office_id AS host_code, e.department AS host_department,
         ${EN('pr')} AS pre_registered_by_name, ${EN('ci')} AS checked_in_by_name, ${EN('co')} AS checked_out_by_name,
         ${EN('ap')} AS approved_by_name, ${EN('rj')} AS rejected_by_name,
         (SELECT COUNT(*)::int FROM gate_passes g WHERE g.visitor_id = v.id AND g.status IN ('pending', 'approved')) AS open_goods
    FROM visitors v
    LEFT JOIN employees e  ON e.id  = v.host_employee_id AND e.company_id IS NOT DISTINCT FROM v.company_id
    LEFT JOIN employees pr ON pr.id = v.pre_registered_by
    LEFT JOIN employees ci ON ci.id = v.checked_in_by
    LEFT JOIN employees co ON co.id = v.checked_out_by
    LEFT JOIN employees ap ON ap.id = v.approved_by
    LEFT JOIN employees rj ON rj.id = v.rejected_by`;

function decorateVisitor(v, ctx) {
  const s = v.effective_status;
  const own = sameId(v.host_employee_id, ctx.employeeId) || sameId(v.pre_registered_by, ctx.employeeId);
  const expected = s === 'pending_approval' || s === 'approved' || s === 'no_show';
  const approved = v.approved_at != null;
  const decidable = expected && !approved;
  return {
    ...v,
    is_mine: own,
    can_approve: decidable && ctx.g.security,
    can_reject: decidable && ctx.g.security,
    can_check_in: expected && approved && ctx.g.add,
    can_approve_check_in: decidable && ctx.g.security && ctx.g.add,
    can_check_out: s === 'inside' && ctx.g.edit && !(v.open_goods > 0),
    checkout_blocked: s === 'inside' && v.open_goods > 0 ? 'A goods pass for this visitor is still open — release or cancel it first.' : null,
    can_edit: (s === 'inside' && ctx.g.edit) || (expected && (ctx.g.edit || ctx.g.add || own)),
    can_cancel: expected && (ctx.g.edit || own),
    can_badge: s === 'inside' && (ctx.g.edit || ctx.g.add),
    can_photo: (s === 'inside' || expected) && (ctx.g.edit || ctx.g.add),
    can_goods: s === 'inside' && v.host_employee_id != null && (ctx.g.add || sameId(v.host_employee_id, ctx.employeeId)),
  };
}

async function loadVisitor(id, ctx) {
  const { tz } = await dayRules(ctx.companyId);
  const { rows: [row] } = await pool.query(
    `${V_SELECT('$3::text')} WHERE v.id = $1 AND ($2::int IS NULL OR v.company_id = $2)`, [id, ctx.companyId, tz]);
  return row ?? null;
}

const maySeeVisitor = (v, ctx) => ctx.g.view || sameId(v.host_employee_id, ctx.employeeId) || sameId(v.pre_registered_by, ctx.employeeId);

/**
 * Validate a visitor payload. Returns { errors, value } with the ID number
 * already MASKED — the full number never leaves this function.
 * `idUnchanged`: the masked value already on the record (an edit that resends it).
 */
export function validateVisitor(body, { preRegister = false, idUnchanged = null, now = new Date() } = {}) {
  const errors = [];
  const v = {
    name: text(body.name), company: text(body.company), phone: text(body.phone), email: text(body.email),
    purpose: text(body.purpose), vehicle_number: text(body.vehicle_number),
    host_employee_id: null, id_type: text(body.id_type), id_number: null, visitor_count: 1, expected_at: null,
  };
  if (v.name === null) errors.push('Enter the visitor’s name');
  for (const [field, label, max] of [['name', 'Name', 200], ['company', 'Company', 200], ['phone', 'Contact number', 20],
    ['email', 'Email', 200], ['purpose', 'Purpose', 1000], ['vehicle_number', 'Vehicle number', 30]]) {
    if (v[field] && v[field].length > max) errors.push(`${label} must be ${max} characters or fewer`);
  }
  if (v.phone && v.phone.length <= 20) {
    const digits = phoneDigits(v.phone).length;
    if (!PHONE_SHAPE.test(v.phone) || digits < 10 || digits > 15) errors.push('Enter a valid contact number (10–15 digits)');
  }
  if (v.email && !EMAIL_SHAPE.test(v.email)) errors.push('Enter a valid email address');
  if (v.vehicle_number) v.vehicle_number = v.vehicle_number.toUpperCase();

  const host = blank(body.host_employee_id);
  if (host !== null) {
    if (!/^\d+$/.test(String(host).trim()) || Number(host) < 1) errors.push('host_employee_id must be a positive integer');
    else v.host_employee_id = Number(host);
  }
  const count = blank(body.visitor_count);
  if (count !== null) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) errors.push('Number of people must be between 1 and 100');
    else v.visitor_count = n;
  }

  if (v.id_type && LEGACY_ID_TYPES[v.id_type]) v.id_type = LEGACY_ID_TYPES[v.id_type];
  const rawId = text(body.id_number);
  if (rawId !== null && idUnchanged !== null && rawId === idUnchanged) {
    v.id_number = idUnchanged;
  } else if (rawId !== null) {
    if (!v.id_type) errors.push('Choose the ID type for the ID number');
    else if (!ID_TYPES.includes(v.id_type)) errors.push(`ID type must be one of ${ID_TYPES.join(', ')}`);
    else {
      const norm = rawId.replace(/[\s-]/g, '').toUpperCase();
      const [re, msg] = ID_RULES[v.id_type];
      if (!re.test(norm)) errors.push(msg);
      else v.id_number = maskIdNumber(norm);
    }
  } else if (v.id_type && !ID_TYPES.includes(v.id_type)) {
    errors.push(`ID type must be one of ${ID_TYPES.join(', ')}`);
  }
  if (rawId === null && v.id_type && !ID_TYPES.includes(v.id_type)) v.id_type = null;

  if (preRegister) {
    const when = blank(body.expected_at);
    if (when === null) errors.push('Enter when the visitor is expected');
    else {
      const t = new Date(when);
      if (isNaN(t.getTime())) errors.push('Expected at must be a valid date/time');
      else if (t.getTime() < now.getTime() - 12 * 3600 * 1000) errors.push('Expected at is in the past');
      else v.expected_at = t;
    }
  }
  return { errors, value: v };
}

async function checkHost(db, hostId, companyId) {
  if (hostId == null) return true;
  const { rows } = await db.query(
    `SELECT id FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL AND ${isCurrentSql('status')}`,
    [hostId, companyId]);
  return rows.length > 0;
}

/** Is this person already inside? Same phone, else same name + company. */
async function openVisitFor(db, companyId, { name, company, phone }, exceptId = null) {
  const who = phone ? `p:${phoneDigits(phone).slice(-10)}` : `n:${name.toLowerCase()}|${(company || '').toLowerCase()}`;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`visitor:${companyId}:${who}`]);
  const { rows } = await db.query(
    `SELECT id, name, check_in_time FROM visitors
      WHERE ($1::int IS NULL OR company_id = $1) AND check_in_time IS NOT NULL AND check_out_time IS NULL
        AND cancelled_at IS NULL AND ($5::int IS NULL OR id <> $5)
        AND (CASE WHEN $2::text IS NOT NULL
                  THEN RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2::text, 10)
                  ELSE phone IS NULL AND LOWER(name) = LOWER($3) AND LOWER(COALESCE(company, '')) = LOWER(COALESCE($4, ''))
             END)
      LIMIT 1`,
    [companyId, phone ? phoneDigits(phone) : null, name, company, exceptId]);
  return rows[0] ?? null;
}

/** Security is told a visitor waits for entry approval. */
async function notifySecurity(v, ctx) {
  await notify(await securityUsers(ctx.companyId), {
    title: `Visitor ${v.name} awaiting entry approval`,
    message: `${v.name}${v.company ? ` (${v.company})` : ''}${v.host_name ? ` to meet ${v.host_name}` : ''} · expected ${fmtWhen(v.expected_at)}${v.purpose ? ` · ${v.purpose}` : ''}`,
    link: '/ApprovalCenter', referenceId: v.id, type: 'visitor_approval', companyId: ctx.companyId, skipUserId: ctx.userId,
  });
}

/** The host (and whoever pre-registered) hears security's decision. */
async function notifyHostDecision(v, ctx, title, message) {
  await notify(await usersOfEmployees([v.host_employee_id, v.pre_registered_by], ctx.companyId), {
    title, message, link: '/MyGatePasses?tab=visitors', referenceId: v.id, type: 'visitor', companyId: ctx.companyId, skipUserId: ctx.userId,
  });
}

async function nextVisitorPass(db) {
  const { rows: [{ n }] } = await db.query(`SELECT nextval('seq_visitor_pass')::int AS n`);
  return `VP-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
}

async function notifyHostArrived(v, ctx) {
  if (v.host_employee_id == null) return;
  const users = await usersOfEmployees([v.host_employee_id], ctx.companyId);
  await notify(users, {
    title: `Your visitor ${v.name} has arrived`,
    message: `${v.name}${v.company ? ` (${v.company})` : ''}${v.visitor_count > 1 ? ` + ${v.visitor_count - 1}` : ''} is at the gate${v.purpose ? ` · ${v.purpose}` : ''}`,
    link: '/MyGatePasses?tab=visitors', referenceId: v.id, type: 'visitor_arrived', companyId: ctx.companyId, skipUserId: ctx.userId,
  });
}

function visitorFilters(req, ctx, tz, { mine }) {
  const range = dateRange(req.query);
  if (range.error) return { error: range.error };
  let status = blank(req.query.status);
  if (req.query.active_only === 'true') status = 'inside';
  if (status !== null && !VISITOR_STATUSES.includes(String(status))) return { error: `status must be one of ${VISITOR_STATUSES.join(', ')}` };
  const hostId = positiveIntOrNull(req.query.host_employee_id);
  if (Number.isNaN(hostId)) return { error: 'host_employee_id must be a positive integer' };
  const params = [ctx.companyId, tz];
  const tzRef = '$2::text';
  // $2 (the zone) is referenced here so the COUNT queries, whose WHERE may use
  // no zone-dependent filter, never carry an unreferenced bind parameter.
  const base = ['($1::int IS NULL OR v.company_id = $1)', `${tzRef} IS NOT NULL`];
  const add = (list, sql, val) => { params.push(val); list.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (mine) add(base, '(v.host_employee_id = $? OR v.pre_registered_by = $?)', ctx.employeeId);
  const baseLen = params.length;
  const where = [...base];
  if (status === 'overstay') where.push(V_OVERSTAY(tzRef));
  else if (status) add(where, `(${V_EFFECTIVE(tzRef)}) = $?`, status);
  if (hostId) add(where, 'v.host_employee_id = $?', hostId);
  const day = `(COALESCE(v.check_in_time, v.expected_at, v.created_at) AT TIME ZONE ${tzRef})::date`;
  if (range.from) add(where, `${day} >= $?::date`, range.from);
  if (range.to)   add(where, `${day} <= $?::date`, range.to);
  const q = blank(req.query.q);
  if (q !== null) {
    add(where, `(v.name ILIKE $? OR v.company ILIKE $? OR v.phone ILIKE $? OR v.email ILIKE $? OR ${EN('e')} ILIKE $? OR v.vehicle_number ILIKE $?)`,
      `%${String(q).trim()}%`);
  }
  return { where, base, params, tzRef, baseLen };
}

/* ─── GET /visitors ─── paged; counts per status; inside_total ───────── */
router.get('/visitors', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    const mine = wantsMine(req, ctx);
    if (mine && ctx.employeeId == null) return res.json({ rows: [], total: 0, page: 1, page_size: 25, counts: {}, inside_total: 0, scope: 'mine' });
    const { tz } = await dayRules(ctx.companyId);
    const f = visitorFilters(req, ctx, tz, { mine });
    if (f.error) return fail(res, 400, f.error);
    const { page, pageSize, offset } = listPage(req.query);
    const [rowsRes, countRes, countsRes] = await Promise.all([
      pool.query(`${V_SELECT(f.tzRef)} WHERE ${f.where.join(' AND ')}
                   ORDER BY (v.check_in_time IS NULL AND v.cancelled_at IS NULL) DESC,
                            COALESCE(v.check_in_time, v.expected_at, v.created_at) DESC, v.id DESC
                   LIMIT ${pageSize} OFFSET ${offset}`, f.params),
      pool.query(`SELECT COUNT(*)::int AS n FROM visitors v
                   LEFT JOIN employees e ON e.id = v.host_employee_id WHERE ${f.where.join(' AND ')}`, f.params),
      pool.query(`SELECT (${V_EFFECTIVE(f.tzRef)}) AS s, COUNT(*)::int AS n,
                         COUNT(*) FILTER (WHERE ${V_OVERSTAY(f.tzRef)})::int AS overstay
                    FROM visitors v WHERE ${f.base.join(' AND ')} GROUP BY 1`, f.params.slice(0, f.baseLen)),
    ]);
    const counts = Object.fromEntries(VISITOR_STATUSES.map(s => [s, 0]));
    for (const r of countsRes.rows) { counts[r.s] = r.n; counts.overstay += r.overstay; }
    res.json({
      rows: rowsRes.rows.map(r => decorateVisitor(r, ctx)),
      total: countRes.rows[0].n, page, page_size: pageSize, counts, inside_total: counts.inside, scope: mine ? 'mine' : 'all',
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /visitors/lookup?phone= ─── a returning visitor's details ───── */
router.get('/visitors/lookup', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    if (!ctx.g.add && !ctx.g.edit) return fail(res, 403, 'Looking up returning visitors needs the Gate Access add permission.');
    const phone = text(req.query.phone);
    if (!phone || phoneDigits(phone).length < 10) return res.json({ found: false });
    const { rows } = await pool.query(
      `SELECT name, company, email, id_type, id_number, vehicle_number, COALESCE(check_in_time, created_at) AS last_visit_at,
              COUNT(*) OVER () AS visits
         FROM visitors
        WHERE ($1::int IS NULL OR company_id = $1)
          AND RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = RIGHT($2::text, 10)
        ORDER BY COALESCE(check_in_time, created_at) DESC, id DESC LIMIT 1`,
      [ctx.companyId, phoneDigits(phone)]);
    if (!rows.length) return res.json({ found: false });
    const r = rows[0];
    res.json({ found: true, name: r.name, company: r.company, email: r.email, id_type: r.id_type, id_number_on_file: r.id_number,
      vehicle_number: r.vehicle_number, last_visit_at: r.last_visit_at, visits: Number(r.visits) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /visitors/export ─── CSV (gate_access:export) ─────────────── */
router.get('/visitors/export', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    if (!ctx.g.export || !ctx.g.view) return fail(res, 403, 'Exporting visitors needs the Gate Access export permission.');
    const { tz } = await dayRules(ctx.companyId);
    const f = visitorFilters(req, ctx, tz, { mine: false });
    if (f.error) return fail(res, 400, f.error);
    const T = (c) => `TO_CHAR(${c} AT TIME ZONE ${f.tzRef}, 'DD Mon YY HH24:MI')`;
    const { rows } = await pool.query(
      `SELECT v.id, v.pass_number, ${EN('ap')} AS approved_by_name, v.reject_reason, v.name, v.company, v.phone, v.email, v.visitor_count, ${EN('e')} AS host, e.department AS host_department,
              v.purpose, v.vehicle_number, v.id_type, v.id_number, ${T('v.expected_at')} AS expected_at,
              ${T('v.check_in_time')} AS check_in, ${T('v.check_out_time')} AS check_out,
              (${V_EFFECTIVE(f.tzRef)}) AS status, v.badge_printed, v.cancel_reason
         FROM visitors v LEFT JOIN employees e ON e.id = v.host_employee_id LEFT JOIN employees ap ON ap.id = v.approved_by
        WHERE ${f.where.join(' AND ')}
        ORDER BY COALESCE(v.check_in_time, v.expected_at, v.created_at) DESC, v.id DESC LIMIT 5000`, f.params);
    const header = ['Visitor pass', 'Approved by', 'Rejected', 'Badge #', 'Visitor', 'Company', 'Phone', 'Email', 'People', 'Host', 'Host department', 'Purpose', 'Vehicle',
      'ID type', 'ID (masked)', 'Expected', 'Check in', 'Check out', 'Status', 'Badge printed', 'Cancel reason'];
    sendCsv(res, `visitors-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(header, rows.map(r => [r.pass_number, r.approved_by_name, r.reject_reason, r.id, r.name, r.company, r.phone,
      r.email, r.visitor_count, r.host, r.host_department, r.purpose, r.vehicle_number, r.id_type, r.id_number, r.expected_at,
      r.check_in, r.check_out, r.status, r.badge_printed ? 'Yes' : 'No', r.cancel_reason].map(x => x ?? ''))));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /visitors/:id ─── one visit and its history ────────────────── */
router.get('/visitors/:id', signedIn, async (req, res) => {
  const id = positiveIntOrNull(req.params.id);
  if (!id) return fail(res, 404, 'Visitor not found');
  try {
    const ctx = await ctxOf(req);
    const v = await loadVisitor(id, ctx);
    if (!v || !maySeeVisitor(v, ctx)) return fail(res, 404, 'Visitor not found');
    const { rows: goods } = await pool.query(
      `SELECT gp.id, gp.pass_number, gp.returnable, gp.purpose, (${GP_EFFECTIVE}) AS effective_status
         FROM gate_passes gp WHERE gp.visitor_id = $1 ORDER BY gp.id`, [id]);
    res.json({ ...decorateVisitor(v, ctx), goods_passes: goods, events: await eventsOf('visitor', id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /visitors ──────────────────────────────────────────────────
 *   walk-in (default)     gate_access:add — registered now, waits for security
 *   pre_register: true    gate_access:add for any host; anyone else with a
 *                         linked employee for a visitor THEY host
 *   approve_and_check_in  a walk-in, approved by the caller (gate_security:approve
 *                         + gate_access:add) and checked in at once
 * Security is notified of every visitor waiting for approval. A second
 * check-in for someone already inside is refused (409). */
router.post('/visitors', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    const preRegister = req.body?.pre_register === true || req.body?.pre_register === 'true';
    const atOnce = !preRegister && (req.body?.approve_and_check_in === true || req.body?.approve_and_check_in === 'true');
    if (!preRegister && !ctx.g.add) return fail(res, 403, 'Registering visitors at the gate needs the Gate Access add permission. You can pre-register your own visitor instead.');
    if (atOnce && !ctx.g.security) return fail(res, 403, 'Only security (Gate Security approve) can approve a visitor\'s entry.');
    const { errors, value: v } = validateVisitor(req.body ?? {}, { preRegister });
    if (!preRegister) v.expected_at = new Date();
    if (preRegister && !ctx.g.add) {
      if (ctx.employeeId == null) return fail(res, 403, 'Your login is not linked to an employee record, so you cannot host a visitor.');
      if (v.host_employee_id != null && !sameId(v.host_employee_id, ctx.employeeId)) return fail(res, 403, 'You can pre-register only your own visitors.');
      v.host_employee_id = ctx.employeeId;
    }
    if (preRegister && v.host_employee_id == null) errors.push('Choose who the visitor is meeting (host)');
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const client = await pool.connect();
    let id;
    try {
      if (!(await checkHost(client, v.host_employee_id, ctx.companyId))) return fail(res, 404, 'Host employee not found, or no longer a current employee');
      await client.query('BEGIN');
      if (atOnce) {
        const open = await openVisitFor(client, ctx.companyId, v);
        if (open) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            message: `${open.name} is already checked in with ${v.phone ? 'this contact number' : 'this name and company'}. Check them out first.`,
            visitor_id: open.id, check_in_time: open.check_in_time });
        }
      }
      const { rows: [row] } = await client.query(
        `INSERT INTO visitors (name, company, phone, email, host_employee_id, purpose, id_type, id_number, vehicle_number,
                               visitor_count, expected_at, check_in_time, checked_in_by, pre_registered_by,
                               pass_number, approved_at, approved_by, approved_by_user_id, company_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW()) RETURNING id`,
        [v.name, v.company, v.phone, v.email, v.host_employee_id, v.purpose, v.id_type, v.id_number, v.vehicle_number,
          v.visitor_count, v.expected_at, atOnce ? new Date() : null, atOnce ? ctx.employeeId : null,
          preRegister ? ctx.employeeId : null,
          atOnce ? await nextVisitorPass(client) : null, atOnce ? new Date() : null, atOnce ? ctx.employeeId : null,
          atOnce ? ctx.userId : null, ctx.companyId]);
      id = row.id;
      await logEvent(client, ctx, 'visitor', id, preRegister ? 'pre_registered' : 'registered');
      if (atOnce) {
        await logEvent(client, ctx, 'visitor', id, 'entry_approved');
        await logEvent(client, ctx, 'visitor', id, 'checked_in');
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }

    const fresh = await loadVisitor(id, ctx);
    if (atOnce) await notifyHostArrived(fresh, ctx);
    else await notifySecurity(fresh, ctx);
    if (preRegister && !sameId(fresh.host_employee_id, ctx.employeeId)) {
      await notify(await usersOfEmployees([fresh.host_employee_id], ctx.companyId), {
        title: `Visitor ${fresh.name} pre-registered for you`,
        message: `Expected ${fmtWhen(fresh.expected_at)}${fresh.purpose ? ` · ${fresh.purpose}` : ''}`,
        link: '/MyGatePasses?tab=visitors', referenceId: id, type: 'visitor', companyId: ctx.companyId, skipUserId: ctx.userId });
    }
    res.status(201).json(decorateVisitor(fresh, ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function visitorForAction(req, res) {
  const id = positiveIntOrNull(req.params.id);
  if (!id) { fail(res, 404, 'Visitor not found'); return null; }
  const ctx = await ctxOf(req);
  const v = await loadVisitor(id, ctx);
  if (!v || !maySeeVisitor(v, ctx)) { fail(res, 404, 'Visitor not found'); return null; }
  return { ctx, v, d: decorateVisitor(v, ctx) };
}

/* ─── PUT /visitors/:id/approve ─── security approves entry (§273) ─────
 * Issues the visitor pass number. The host is told. */
router.put('/visitors/:id/approve', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!ctx.g.security) return res.status(403).json({ code: 'NOT_SECURITY', message: 'Only security (Gate Security approve) can approve a visitor\'s entry.' });
    if (!d.can_approve) return fail(res, 409, `This visitor is ${v.effective_status.replace('_', ' ')} and cannot be approved.`, { current_status: v.effective_status });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const number = v.pass_number || await nextVisitorPass(client);
      const { rowCount } = await client.query(
        `UPDATE visitors SET approved_at = NOW(), approved_by = $3, approved_by_user_id = $4, pass_number = $5, updated_at = NOW()
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND approved_at IS NULL AND rejected_at IS NULL
            AND cancelled_at IS NULL AND check_in_time IS NULL`,
        [v.id, ctx.companyId, ctx.employeeId, ctx.userId, number]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was decided meanwhile.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'entry_approved', text(req.body?.comment), { pass_number: number });
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const fresh = await loadVisitor(v.id, ctx);
    await notifyHostDecision(fresh, ctx, `Visitor ${fresh.name} approved — pass ${fresh.pass_number}`,
      `Security approved entry${fresh.expected_at ? ` for ${fmtWhen(fresh.expected_at)}` : ''}.`);
    res.json(decorateVisitor(fresh, ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/reject ─── security refuses entry, with a reason ── */
router.put('/visitors/:id/reject', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!ctx.g.security) return res.status(403).json({ code: 'NOT_SECURITY', message: 'Only security (Gate Security approve) can refuse a visitor\'s entry.' });
    if (!d.can_reject) return fail(res, 409, `This visitor is ${v.effective_status.replace('_', ' ')} and cannot be rejected.`, { current_status: v.effective_status });
    const reason = text(req.body?.reason);
    if (reason === null) return fail(res, 400, 'Give a reason');
    if (reason.length > 500) return fail(res, 400, 'The reason must be 500 characters or fewer');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE visitors SET rejected_at = NOW(), rejected_by = $3, reject_reason = $4, updated_at = NOW()
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND approved_at IS NULL AND rejected_at IS NULL
            AND cancelled_at IS NULL AND check_in_time IS NULL`,
        [v.id, ctx.companyId, ctx.employeeId, reason]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was decided meanwhile.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'entry_rejected', reason);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const fresh = await loadVisitor(v.id, ctx);
    await notifyHostDecision(fresh, ctx, `Visitor ${fresh.name} not approved`, reason);
    res.json(decorateVisitor(fresh, ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/check-in ─── an approved visitor arrives ───────
 * Refused until security has approved. body.approve: a security user who is
 * also the gate desk approves and checks in in one step. The desk can complete
 * the details the host did not know (ID, phone, vehicle). */
router.put('/visitors/:id/check-in', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    const approveNow = req.body?.approve === true && d.can_approve_check_in;
    if (!d.can_check_in && !approveNow) {
      if (!ctx.g.add) return fail(res, 403, 'Checking visitors in needs the Gate Access add permission.');
      if (['pending_approval', 'no_show'].includes(v.effective_status) && !v.approved_at) {
        return res.status(409).json({ code: 'NOT_APPROVED', message: 'Security has not approved this visitor\'s entry yet.', current_status: v.effective_status });
      }
      return fail(res, 409, `This visitor is ${v.effective_status.replace('_', ' ')} and cannot be checked in.`, { current_status: v.effective_status });
    }
    const merged = { ...v, ...pickVisitorBody(req.body ?? {}), id_number: req.body?.id_number ?? v.id_number };
    const { errors, value } = validateVisitor(merged, { idUnchanged: v.id_number });
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const open = await openVisitFor(client, ctx.companyId, value, v.id);
      if (open) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `${open.name} is already checked in with ${value.phone ? 'this contact number' : 'this name and company'}. Check them out first.`, visitor_id: open.id });
      }
      if (approveNow) {
        const number = v.pass_number || await nextVisitorPass(client);
        const { rowCount: ok } = await client.query(
          `UPDATE visitors SET approved_at = NOW(), approved_by = $3, approved_by_user_id = $4, pass_number = $5
            WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND approved_at IS NULL AND rejected_at IS NULL`,
          [v.id, ctx.companyId, ctx.employeeId, ctx.userId, number]);
        if (!ok) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was decided meanwhile.'); }
        await logEvent(client, ctx, 'visitor', v.id, 'entry_approved', null, { pass_number: number });
      }
      const { rowCount } = await client.query(
        `UPDATE visitors SET check_in_time = NOW(), checked_in_by = $3, phone = $4, email = $5, company = $6, id_type = $7,
                id_number = $8, vehicle_number = $9, visitor_count = $10, name = $11, updated_at = NOW()
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND check_in_time IS NULL AND cancelled_at IS NULL
            AND approved_at IS NOT NULL AND rejected_at IS NULL`,
        [v.id, ctx.companyId, ctx.employeeId, value.phone, value.email, value.company, value.id_type, value.id_number,
          value.vehicle_number, value.visitor_count, value.name]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was checked in, rejected or cancelled meanwhile.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'checked_in');
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const fresh = await loadVisitor(v.id, ctx);
    await notifyHostArrived(fresh, ctx);
    res.json(decorateVisitor(fresh, ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

const VISITOR_FIELDS = ['name', 'company', 'phone', 'email', 'host_employee_id', 'purpose', 'id_type', 'id_number', 'vehicle_number', 'visitor_count', 'expected_at'];
const pickVisitorBody = (b) => Object.fromEntries(VISITOR_FIELDS.filter(k => k in b).map(k => [k, b[k]]));

/* ─── PUT /visitors/:id ─── edit an expected or inside visitor ───────── */
router.put('/visitors/:id', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!d.can_edit) {
      return fail(res, ['checked_out', 'cancelled'].includes(v.effective_status) ? 409 : 403,
        ['checked_out', 'cancelled'].includes(v.effective_status) ? `This visit is ${v.effective_status.replace('_', ' ')} and can no longer be edited.`
          : 'You cannot edit this visitor.', { current_status: v.effective_status });
    }
    const expected = ['pending_approval', 'approved', 'no_show'].includes(v.effective_status);
    const merged = { ...v, ...pickVisitorBody(req.body ?? {}) };
    if (!expected) merged.expected_at = v.expected_at;
    const { errors, value } = validateVisitor(merged, { preRegister: expected, idUnchanged: v.id_number });
    if (!ctx.g.add && !ctx.g.edit && !sameId(value.host_employee_id, v.host_employee_id)) errors.push('Only the gate desk can change the host');
    if (expected && value.host_employee_id == null) errors.push('Choose who the visitor is meeting (host)');
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    if (!sameId(value.host_employee_id, v.host_employee_id) && !(await checkHost(pool, value.host_employee_id, ctx.companyId))) {
      return fail(res, 404, 'Host employee not found, or no longer a current employee');
    }
    const changed = VISITOR_FIELDS.filter(k => String(value[k] instanceof Date ? value[k].toISOString() : value[k] ?? '')
      !== String(v[k] instanceof Date ? v[k].toISOString() : v[k] ?? ''));
    // Security approved WHO is coming and WHEN: a change to that by anyone but
    // security sends the visit back for approval (§273).
    const IDENTITY = ['name', 'company', 'phone', 'host_employee_id', 'visitor_count', 'expected_at'];
    const reapprove = expected && v.approved_at != null && !ctx.g.security && changed.some(k => IDENTITY.includes(k));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE visitors SET name=$3, company=$4, phone=$5, email=$6, host_employee_id=$7, purpose=$8, id_type=$9, id_number=$10,
                vehicle_number=$11, visitor_count=$12, expected_at=$13, updated_at=NOW(),
                approved_at = CASE WHEN $14::boolean THEN NULL ELSE approved_at END,
                approved_by = CASE WHEN $14::boolean THEN NULL ELSE approved_by END
          WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) AND check_out_time IS NULL AND cancelled_at IS NULL`,
        [v.id, ctx.companyId, value.name, value.company, value.phone, value.email, value.host_employee_id, value.purpose,
          value.id_type, value.id_number, value.vehicle_number, value.visitor_count, expected ? value.expected_at : v.expected_at, reapprove]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visit was closed while you were editing it.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'edited', reapprove ? 'Changed after approval — back to security' : null, { fields: changed });
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    const fresh = await loadVisitor(v.id, ctx);
    if (reapprove) await notifySecurity(fresh, ctx);
    res.json(decorateVisitor(fresh, ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/checkout ─── once only ──────────────────────── */
router.put('/visitors/:id/checkout', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!ctx.g.edit) return fail(res, 403, 'Checking visitors out needs the Gate Access edit permission.');
    if (d.checkout_blocked) return res.status(409).json({ code: 'GOODS_OPEN', message: d.checkout_blocked });
    if (!d.can_check_out) {
      if (v.check_out_time) {
        return res.status(409).json({ message: `This visitor already checked out at ${new Date(v.check_out_time).toISOString()}.`, check_out_time: v.check_out_time });
      }
      return fail(res, 409, `This visitor is ${v.effective_status.replace('_', ' ')} and cannot be checked out.`);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE visitors SET check_out_time = GREATEST(NOW(), check_in_time), checked_out_by = $3, updated_at = NOW()
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND check_in_time IS NOT NULL AND check_out_time IS NULL`,
        [v.id, ctx.companyId, ctx.employeeId]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was checked out meanwhile.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'checked_out', text(req.body?.note));
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    res.json(decorateVisitor(await loadVisitor(v.id, ctx), ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/cancel ─── an expected visit that will not happen ── */
router.put('/visitors/:id/cancel', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!d.can_cancel) return fail(res, 409, `This visitor is ${v.effective_status.replace('_', ' ')} and cannot be cancelled.`);
    const reason = text(req.body?.reason);
    if (reason === null) return fail(res, 400, 'Give a reason');
    if (reason.length > 500) return fail(res, 400, 'The reason must be 500 characters or fewer');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE visitors SET cancelled_at = NOW(), cancelled_by = $3, cancel_reason = $4, updated_at = NOW()
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND check_in_time IS NULL AND cancelled_at IS NULL`,
        [v.id, ctx.companyId, ctx.employeeId, reason]);
      if (!rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'This visitor was checked in meanwhile.'); }
      await logEvent(client, ctx, 'visitor', v.id, 'cancelled', reason);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    res.json(decorateVisitor(await loadVisitor(v.id, ctx), ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/badge ─── record that a badge was printed ────── */
router.put('/visitors/:id/badge', signedIn, async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!ctx.g.add && !ctx.g.edit) return fail(res, 403, 'Printing badges needs the Gate Access add or edit permission.');
    if (!d.can_badge) return fail(res, 409, 'A badge can be printed only while the visitor is inside.');
    await pool.query(`UPDATE visitors SET badge_printed = true, updated_at = NOW() WHERE id = $1`, [v.id]);
    await logEvent(pool, ctx, 'visitor', v.id, v.badge_printed ? 'badge_reprinted' : 'badge_printed');
    res.json(decorateVisitor(await loadVisitor(v.id, ctx), ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /visitors/:id/photo ─── multipart `photo_file`, an image ───── */
router.put('/visitors/:id/photo', signedIn, singleFileUpload('photo_file'), async (req, res) => {
  try {
    const got = await visitorForAction(req, res); if (!got) return undefined;
    const { ctx, v, d } = got;
    if (!d.can_photo) return fail(res, ctx.g.add || ctx.g.edit ? 409 : 403, 'You cannot add a photo to this visit.');
    const f = req.file;
    if (!f) return fail(res, 400, 'Choose a photo');
    if (!f.mimetype.startsWith('image/')) return fail(res, 415, 'The photo must be an image (JPG, PNG, WebP or GIF).');
    const url = await uploadFile(f.buffer, f.originalname || 'visitor.jpg', f.mimetype);
    await pool.query(`UPDATE visitors SET photo_url = $2, updated_at = NOW() WHERE id = $1`, [v.id, url]);
    if (v.photo_url) await deleteFile(v.photo_url).catch(() => {});
    await logEvent(pool, ctx, 'visitor', v.id, v.photo_url ? 'photo_replaced' : 'photo_added');
    res.json(decorateVisitor(await loadVisitor(v.id, ctx), ctx));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══ GET /gate-access/summary ─── the cards on top of the register ═══ */
router.get('/gate-access/summary', signedIn, async (req, res) => {
  try {
    const ctx = await ctxOf(req);
    if (!ctx.g.view) return fail(res, 403, 'The gate register needs the Gate Access view permission.');
    const { tz } = await dayRules(ctx.companyId);
    const [passes, visitors] = await Promise.all([
      pool.query(
        `SELECT (${GP_EFFECTIVE}) AS s, gp.pass_type, COUNT(*)::int AS n FROM gate_passes gp
          WHERE ($1::int IS NULL OR gp.company_id = $1) AND gp.status IN ('pending', 'approved', 'out')
          GROUP BY 1, 2`, [ctx.companyId]),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE (${V_EFFECTIVE('$2::text')}) = 'inside')::int AS inside,
                COUNT(*) FILTER (WHERE ${V_OVERSTAY('$2::text')})::int AS overstay,
                COUNT(*) FILTER (WHERE (${V_EFFECTIVE('$2::text')}) = 'pending_approval')::int AS awaiting_security,
                COUNT(*) FILTER (WHERE (${V_EFFECTIVE('$2::text')}) IN ('pending_approval', 'approved')
                                   AND (v.expected_at AT TIME ZONE $2::text)::date = (NOW() AT TIME ZONE $2::text)::date)::int AS expected_today
           FROM visitors v WHERE ($1::int IS NULL OR v.company_id = $1)`, [ctx.companyId, tz]),
    ]);
    const sum = (pred) => passes.rows.filter(pred).reduce((a, r) => a + r.n, 0);
    res.json({
      pending: sum(r => r.s === 'pending'),
      approved: sum(r => r.s === 'approved'),
      people_out: sum(r => r.pass_type === 'person' && (r.s === 'out' || r.s === 'overdue')),
      goods_out: sum(r => r.pass_type === 'material' && (r.s === 'out' || r.s === 'overdue')),
      overdue: sum(r => r.s === 'overdue'),
      ...visitors.rows[0],
      timezone: tz,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
