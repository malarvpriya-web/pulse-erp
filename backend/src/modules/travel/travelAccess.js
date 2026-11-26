/**
 * travelAccess.js — who may see and do what in Travel Desk (26 Nov 26).
 *
 * The travel routes used to self-scope ONLY when the caller's primary role was
 * literally 'employee'. Every other role — 299 service engineers, sales, stores —
 * read every trip, advance and booking in the company. Scope is now decided here,
 * for every route, from ALL the roles a login holds (roles are many-to-many):
 *
 *   company-wide   admin, super_admin, the HR desk and the Finance desk
 *   everyone else  their own records + their direct reports' + anything
 *                  delegated to them (a manager is just someone with reports)
 *
 * Bookings are made by the travel desk = admin / super_admin (owner, 26 Nov 26).
 */
import pool from '../shared/db.js';
import { hasRole } from '../../middlewares/auth.middleware.js';

export const TRAVEL_ALL_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'finance', 'finance_manager', 'accounts_exec'];
export const TRAVEL_DESK_ROLES = ['admin', 'super_admin'];
export const ADVANCE_FINANCE_ROLES = ['admin', 'super_admin', 'finance', 'finance_manager', 'accounts_exec'];
// Spend analytics: the company-wide desks plus line managers (as the menu grants).
export const TRAVEL_ANALYTICS_ROLES = [...TRAVEL_ALL_ROLES, 'manager', 'department_head'];

export const uid = (req) => req.user?.userId ?? req.user?.id ?? null;
export const seesAllTravel = (req) => hasRole(req, ...TRAVEL_ALL_ROLES);
export const isTravelDesk = (req) => hasRole(req, ...TRAVEL_DESK_ROLES);

export async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return Number(req.user.employee_id);
  const userId = uid(req);
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

/**
 * SQL predicate limiting `alias` rows to what the caller may read. Pushes its
 * values onto `params` and returns '' for the company-wide desks.
 *
 *   empCol      column holding the traveller's employees.id
 *   creatorCol  column holding the users.id that filed it (or null)
 *   delegateCol column holding a delegate employees.id (or null)
 */
export async function travelScope(req, params, { empCol, creatorCol = null, delegateCol = null }) {
  if (seesAllTravel(req)) return '';
  const eid = (await ownEmployeeId(req)) ?? -1;
  params.push(eid);
  const e = `$${params.length}`;
  const parts = [`${empCol} = ${e}`, `${empCol} IN (SELECT id FROM employees WHERE reporting_manager_id = ${e})`];
  if (delegateCol) parts.push(`${delegateCol} = ${e}`);
  if (creatorCol) { params.push(uid(req) ?? -1); parts.push(`${creatorCol} = $${params.length}`); }
  return ` AND (${parts.join(' OR ')})`;
}

/** May the caller read this one trip? */
export async function canSeeTrip(req, tr) {
  if (!tr) return false;
  if (seesAllTravel(req)) return true;
  const eid = await ownEmployeeId(req);
  if (eid != null && (Number(tr.employee_id) === eid || Number(tr.delegate_approver_id) === eid)) return true;
  if (tr.created_by != null && Number(tr.created_by) === Number(uid(req))) return true;
  if (eid == null || tr.employee_id == null) return false;
  const { rows } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2', [tr.employee_id, eid]);
  return rows.length > 0;
}

/** Is the caller the traveller (or the login that filed it)? */
export async function ownsTrip(req, tr) {
  if (!tr) return false;
  const eid = await ownEmployeeId(req);
  return (eid != null && Number(tr.employee_id) === eid) ||
         (tr.created_by != null && Number(tr.created_by) === Number(uid(req)));
}

/**
 * Next document number PREFIX-YYYY-NNNN for `table.col`, from the global maximum
 * under a transaction-scoped advisory lock (the column is UNIQUE across
 * companies; COUNT(*)+1 repeated a number after any delete). Call inside a
 * transaction.
 */
export async function nextDocNumber(client, table, col, prefix) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}.${col}`]);
  const yr = new Date().getFullYear();
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(substring(${col} FROM $1), '')::int), 0) + 1 AS seq
       FROM ${table} WHERE ${col} LIKE $2`,
    [`^${prefix}-${yr}-([0-9]+)$`, `${prefix}-${yr}-%`]);
  return `${prefix}-${yr}-${String(r.seq).padStart(4, '0')}`;
}

/** Today as YYYY-MM-DD in the business time zone (process TZ is pinned). */
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Last day of a month as YYYY-MM-DD without a UTC round-trip. */
export function monthEnd(y, m) {
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

// Travel types whose trip needs a visit report before the trip's claims can be
// submitted.
export const MANDATORY_REPORT_TYPES = new Set([
  'Sales Visit', 'Application Engineering', 'Commissioning',
  'Service Visit', 'AMC Visit', 'Site Survey', 'Installation',
]);

/**
 * The one policy rule for an employee — grade first, then designation (role),
 * then department, honouring effective dates. The claim save and the on-screen
 * preview used to choose rules in two different orders and could disagree.
 */
export async function policyRuleFor(db, companyId, emp, onDate = null) {
  if (!emp) return null;
  const { rows: [rule] } = await db.query(`
    SELECT * FROM travel_policy_rules
     WHERE is_active = TRUE AND company_id = $1
       AND ( (rule_type = 'grade' AND grade = $2) OR (rule_type = 'role' AND role = $3)
          OR (rule_type = 'department' AND department = $4) )
       AND (effective_from IS NULL OR effective_from <= COALESCE($5::date, CURRENT_DATE))
       AND (effective_to   IS NULL OR effective_to   >= COALESCE($5::date, CURRENT_DATE))
     ORDER BY CASE rule_type WHEN 'grade' THEN 1 WHEN 'role' THEN 2 ELSE 3 END, id
     LIMIT 1`, [companyId, emp.grade || '', emp.designation || '', emp.department || '', onDate]);
  return rule || null;
}

/** The limit column a claim's expense type is checked against. */
export function policyLimitFor(rule, expenseType) {
  if (!rule) return null;
  const v = expenseType === 'Accommodation' ? rule.hotel_limit_per_day
    : expenseType === 'Food' ? rule.meal_limit_per_day
    : expenseType === 'Travel' ? rule.local_conveyance_limit
    : rule.miscellaneous_limit;
  const n = Number(v);
  return n > 0 ? n : null;
}
