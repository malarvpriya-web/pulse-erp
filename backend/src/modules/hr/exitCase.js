/**
 * exitCase.js — the rules every "start an exit" path shares (§274).
 *
 * Exits were created by three handlers with three different sets of checks
 * (11-03 audit D-14): POST /exit/initiate, POST /exit/requests and
 * POST /employees/:id/offboard. None refused a second open exit (F-14), none
 * refused a deleted or already-departed employee, and only one required a last
 * working day. All three now call startExitChecks() inside their transaction;
 * the partial unique index exit_requests_one_open_per_employee (migration
 * 20261112000006) backs the open-exit rule under a race.
 */
import pool from '../shared/db.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';
import { KNOWN_SEPARATIONS } from './settlementEngine.js';
import { EXITED_STATUSES, isCurrentSql } from '../../shared/employeeStatus.js';
import { getWorkforcePolicy } from '../../shared/workforcePolicy.js';

/** Exit request statuses that are finished. Everything else is open. Matches GET /exit/active. */
export const CLOSED_EXIT_STATUSES = ['closed', 'paid', 'cancelled', 'rejected'];

/** The exit types the F&F engine knows. Anything else is treated as resignation there, so refuse it here. */
export const SEPARATION_TYPES = KNOWN_SEPARATIONS;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class ExitInputError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const blank = (v) => v == null || String(v).trim() === '';

/** "Contract Expiry" / "contract-expiry" → 'contract_expiry'; 400 when the engine doesn't know it. */
export function cleanSeparationType(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!SEPARATION_TYPES.includes(s)) {
    throw new ExitInputError(400, 'SEPARATION_TYPE_INVALID', `Exit type must be one of: ${SEPARATION_TYPES.join(', ')}.`);
  }
  return s;
}

/**
 * Validate and normalise the editable exit fields. `partial` = an edit: only the
 * fields present are checked, and nothing is required. `current` = the stored
 * exit, so an edit of one date is checked against the other.
 * Returns { separation_type?, last_working_date?, resignation_date?, notice_period?, reason? }.
 */
export function cleanExitFields(body, { partial = false, current = null } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body ?? {}, k);

  if (!partial || has('separation_type')) out.separation_type = cleanSeparationType(body?.separation_type ?? 'resignation');
  if (!partial || has('last_working_date')) {
    const d = String(body?.last_working_date ?? '').trim().slice(0, 10);
    if (!ISO.test(d)) throw new ExitInputError(400, 'LWD_REQUIRED', 'Last working day is required (YYYY-MM-DD).');
    out.last_working_date = d;
  }
  if (has('resignation_date')) {
    const d = String(body.resignation_date ?? '').trim().slice(0, 10);
    if (d && !ISO.test(d)) throw new ExitInputError(400, 'RESIGNATION_DATE_INVALID', 'Resignation / notice date must be a date (YYYY-MM-DD).');
    out.resignation_date = d || null;
  }
  if (has('notice_period')) {
    if (blank(body.notice_period)) out.notice_period = null;
    else {
      const n = Number(body.notice_period);
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        throw new ExitInputError(400, 'NOTICE_PERIOD_INVALID', 'Notice period must be a whole number of days between 0 and 365.');
      }
      out.notice_period = n;
    }
  }
  if (has('reason')) out.reason = blank(body.reason) ? null : String(body.reason).trim().slice(0, 2000);

  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
  const lwd = out.last_working_date ?? iso(current?.last_working_date);
  const rd = has('resignation_date') ? out.resignation_date : iso(current?.resignation_date);
  if (rd && lwd && rd > lwd) {
    throw new ExitInputError(400, 'RESIGNATION_AFTER_LWD', 'The resignation / notice date cannot be after the last working day.');
  }
  return out;
}

/**
 * Inside a transaction: lock the employee and prove an exit may start.
 * 404 not in the caller's company or deleted; 409 already left; 409 an exit is
 * already open. Returns the employee row (id, name, status, department,
 * reporting_manager_id, notice_period_days, company_id).
 */
export async function startExitChecks(client, employeeId, companyId) {
  const { rows: [emp] } = await client.query(
    `SELECT id, COALESCE(name, first_name || ' ' || last_name) AS name, office_id, status, department,
            reporting_manager_id, notice_period_days, company_id
       FROM employees
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)
      FOR UPDATE`,
    [employeeId, companyId]
  );
  if (!emp) throw new ExitInputError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  if (EXITED_STATUSES.includes(String(emp.status ?? '').trim().toLowerCase())) {
    throw new ExitInputError(409, 'EMPLOYEE_ALREADY_LEFT', `${emp.name} has already left (status ${emp.status}). Use Rehire on Ex-Employees instead.`);
  }
  const { rows: [open] } = await client.query(
    `SELECT id, status, last_working_date FROM exit_requests
      WHERE employee_id = $1 AND status <> ALL($2::text[]) LIMIT 1`,
    [employeeId, CLOSED_EXIT_STATUSES]
  );
  if (open) {
    throw new ExitInputError(409, 'EXIT_ALREADY_OPEN',
      `${emp.name} already has an open exit (#${open.id}, ${open.status}). Edit or withdraw that one instead of starting another.`);
  }
  return emp;
}

/**
 * Start the clearance checklist from nothing. exit_clearance is one row per
 * EMPLOYEE, not per exit (F-15), so a rehired person's second exit inherited
 * every tick and sign-off of the first. startExitChecks() has proved no exit is
 * open, so any row here belongs to a finished exit. Returns the previous row
 * (for the audit log) or null.
 */
export async function freshClearance(client, employeeId) {
  const { rows: [prev] } = await client.query(`SELECT * FROM exit_clearance WHERE employee_id = $1`, [employeeId]);
  // The company checklist items are part of the same exit checklist (merged
  // 2026-11-17): they are archived with the sign-offs and start again too.
  const { rows: items } = await client.query(
    `SELECT category, item_label, done, assignee, due_date, handover_notes, completed_at
       FROM hr_offboarding_checklist_progress WHERE employee_id = $1 ORDER BY category, item_label`, [employeeId]);
  // Keep the earlier exit's clearance before clearing it (B7, migration
  // 20261116000007), linked to the most recent FINISHED exit — the one it was
  // signed for. The new exit is open, so it is never picked.
  if (prev || items.length) {
    await client.query(
      `INSERT INTO exit_clearance_history (employee_id, exit_request_id, clearance)
       VALUES ($1,
               (SELECT id FROM exit_requests
                 WHERE employee_id = $1 AND LOWER(COALESCE(status, '')) = ANY($3::text[])
                 ORDER BY created_at DESC, id DESC LIMIT 1),
               $2::jsonb)`,
      [employeeId, JSON.stringify({ ...(prev || {}), checklist_items: items }), CLOSED_EXIT_STATUSES]);
  }
  await client.query(`DELETE FROM hr_offboarding_checklist_progress WHERE employee_id = $1`, [employeeId]);
  await client.query(
    `INSERT INTO exit_clearance (employee_id) VALUES ($1)
     ON CONFLICT (employee_id) DO UPDATE
       SET it_assets_returned=false, access_revoked=false, documents_collected=false,
           exit_interview_done=false, noc_it=false, noc_admin=false, noc_finance=false,
           noc_hr=false, noc_manager=false, finance_noc_by=NULL, manager_noc_by=NULL,
           hr_noc_by=NULL, updated_at=NOW()`,
    [employeeId]);
  return prev ?? null;
}

/**
 * The notice an exit records when HR leaves it blank (§275): the employee's
 * contractual notice, else the company default (Workforce Analytics → Settings).
 */
export async function defaultNoticeDays(db, employee) {
  if (employee?.notice_period_days != null) return Number(employee.notice_period_days);
  return (await getWorkforcePolicy(db, employee?.company_id ?? null)).default_notice_period_days;
}

/** The unique index fired: someone started the same employee's exit a moment earlier. */
export function isOpenExitRace(err) {
  return err?.code === '23505' && /exit_requests_one_open_per_employee/.test(String(err?.constraint ?? err?.message ?? ''));
}

/** Map an error from the exit create/edit paths to an HTTP response. */
export function sendExitError(res, err) {
  if (err instanceof ExitInputError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (isOpenExitRace(err)) return res.status(409).json({ error: 'This employee already has an open exit.', code: 'EXIT_ALREADY_OPEN' });
  return res.status(err.status || 500).json({ error: err.message });
}

/**
 * Tell the leaver's department head and reporting manager that an exit was
 * recorded, so handover and manager clearance can start. The leaver is not
 * notified here: for a termination HR decides how and when that is said.
 * Never throws — a notification failure must not undo the exit.
 */
export async function notifyExitStarted({ employee, exitRequest, actorUserId }) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id
         FROM employees pe
         JOIN LATERAL (
           SELECT h.id AS emp_id FROM master_departments d
             JOIN department_heads dh ON dh.department_id = d.id AND dh.ended_at IS NULL AND dh.company_id = pe.company_id
             JOIN employees h ON h.id = dh.head_employee_id
            WHERE LOWER(BTRIM(d.name)) = LOWER(BTRIM(pe.department)) AND d.is_active = true
              AND h.company_id = pe.company_id AND h.deleted_at IS NULL AND ${isCurrentSql('h.status')}
           UNION
           SELECT m.id FROM employees m
            WHERE m.id = pe.reporting_manager_id AND m.company_id = pe.company_id
              AND m.deleted_at IS NULL AND ${isCurrentSql('m.status')}
         ) who ON who.emp_id <> pe.id
         JOIN users u ON u.employee_id = who.emp_id AND u.is_active = true
        WHERE pe.id = $1`,
      [employee.id]
    );
    const lwd = String(exitRequest.last_working_date ?? '').slice(0, 10);
    const type = String(exitRequest.separation_type ?? '').replace(/_/g, ' ');
    const title = `Exit recorded: ${employee.name}`;
    const message = `${employee.name}${employee.office_id ? ` (${employee.office_id})` : ''} is leaving (${type}). `
      + `Last working day ${lwd || 'not set'}. Please plan the handover and complete the manager clearance in Exit Management.`;
    for (const { id: userId } of rows) {
      if (userId === actorUserId) continue;
      await notificationsRepository.create({
        user_id: userId, title, message, module_name: 'HR', reference_id: exitRequest.id,
        notification_type: 'info', company_id: employee.company_id,
      }).catch((e) => console.error('[exit] notification failed:', e.message));
    }
    return rows.length;
  } catch (err) {
    console.error('[exit] notification lookup failed:', err.message);
    return 0;
  }
}
