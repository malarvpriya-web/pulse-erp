/**
 * Late-coming penalties (§278.3, owner 2026-11-19).
 *
 * The rules live in attendance_policies (policy_type 'penalty', rules.rules[])
 * and are edited in Attendance → Configuration → Settings → Late-coming
 * penalties. Payroll Sync adds the result to the month's loss-of-pay days; the
 * monthly report, My Attendance and the managers' monthly summary show it.
 *
 * Rule kinds:
 *   late_count   every `count` days late by more than `minutes` → deduct_days
 *   late_each    each day late by more than `minutes`           → deduct_days
 *   early_count  every `count` days leaving more than `minutes` early → deduct_days
 *   early_each   each day leaving more than `minutes` early      → deduct_days
 *
 * Only days the employee was present (present / late) count — absent and
 * half days are already loss of pay. A day caught by an "each" rule is not
 * counted again by a "count" rule of the same kind (late or early), so the
 * owner's example "late > 60 min = half day" and "3 lates > 15 min = half day"
 * never charge the same morning twice. The total for a month never exceeds the
 * days present.
 */
import pool from '../config/db.js';

export const PENALTY_KINDS = ['late_count', 'late_each', 'early_count', 'early_each'];

/** Validate and normalise a rule list coming from the Settings screen. */
export function normaliseRules(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('penalty_rules must be a list'), { status: 400 });
  if (input.length > 30) throw Object.assign(new Error('At most 30 penalty rules'), { status: 400 });
  return input.map((r, i) => {
    const kind = String(r?.kind || '');
    if (!PENALTY_KINDS.includes(kind)) throw Object.assign(new Error(`Rule ${i + 1}: choose what the rule is about`), { status: 400 });
    const minutes = Math.round(Number(r.minutes));
    const count = kind.endsWith('_each') ? 1 : Math.round(Number(r.count));
    const deduct = Number(r.deduct_days);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) throw Object.assign(new Error(`Rule ${i + 1}: minutes must be 1–600`), { status: 400 });
    if (!Number.isFinite(count) || count < 1 || count > 31) throw Object.assign(new Error(`Rule ${i + 1}: times must be 1–31`), { status: 400 });
    // Half or full day only: payroll_attendance_summary.lop_days holds one decimal.
    if (![0.5, 1].includes(deduct)) throw Object.assign(new Error(`Rule ${i + 1}: cut half a day or a full day`), { status: 400 });
    return {
      id: String(r.id || `r${Date.now().toString(36)}${i}`).slice(0, 40),
      kind, minutes, count, deduct_days: deduct, active: r.active !== false,
    };
  });
}

export async function loadPenaltyRules(companyId, db = pool) {
  const { rows: [p] } = await db.query(`
    SELECT rules FROM attendance_policies
     WHERE policy_type = 'penalty' AND is_active = true AND (company_id = $1 OR company_id IS NULL)
     ORDER BY company_id DESC NULLS LAST, id LIMIT 1`, [companyId ?? null]).catch(() => ({ rows: [] }));
  return Array.isArray(p?.rules?.rules) ? p.rules.rules : [];
}

/** Plain-language line for a rule, e.g. "Every 3 late arrivals of more than 15 min → cut half a day". */
export function describeRule(r) {
  const cut = Number(r.deduct_days) === 1 ? 'a full day' : 'half a day';
  const what = r.kind.startsWith('late') ? `late arrivals of more than ${r.minutes} min` : `early exits of more than ${r.minutes} min`;
  const once = r.kind.startsWith('late') ? `Late by more than ${r.minutes} min` : `Leaving more than ${r.minutes} min early`;
  return r.kind.endsWith('_each') ? `${once} → cut ${cut} each time` : `Every ${r.count} ${what} in a month → cut ${cut}`;
}

/**
 * Apply rules to one employee's days.
 * @param {Array<{date:string,status:string,late_minutes:number,early_leave_minutes:number}>} days
 * @returns {{ days:number, lines:Array<{rule_id,text,occurrences,deduct_days}> }}
 */
export function applyRules(rules, days) {
  const present = days.filter((d) => ['present', 'late'].includes(String(d.status || '').toLowerCase()));
  const active = rules.filter((r) => r.active !== false && PENALTY_KINDS.includes(r.kind));
  const taken = { late: new Set(), early: new Set() };
  const lines = [];
  // "each" rules first, so their days are not counted twice.
  for (const r of [...active.filter((x) => x.kind.endsWith('_each')), ...active.filter((x) => x.kind.endsWith('_count'))]) {
    const side = r.kind.startsWith('late') ? 'late' : 'early';
    const col = side === 'late' ? 'late_minutes' : 'early_leave_minutes';
    const hits = present.filter((d) => Number(d[col] || 0) > r.minutes && !(r.kind.endsWith('_count') && taken[side].has(d.date)));
    let deduct = 0;
    if (r.kind.endsWith('_each')) {
      hits.forEach((d) => taken[side].add(d.date));
      deduct = hits.length * r.deduct_days;
    } else {
      deduct = Math.floor(hits.length / r.count) * r.deduct_days;
    }
    if (hits.length) {
      lines.push({ rule_id: r.id, text: describeRule(r), occurrences: hits.length, deduct_days: deduct, dates: hits.map((d) => d.date) });
    }
  }
  const total = Math.min(present.length, lines.reduce((s, l) => s + l.deduct_days, 0));
  return { days: Math.round(total * 100) / 100, lines };
}

/**
 * Penalties for many employees over a date range, in one query.
 * @returns {Map<number, {days:number, lines:Array}>}
 */
export async function computePenalties(companyId, employeeIds, from, to, db = pool) {
  const out = new Map();
  if (!employeeIds.length || from > to) return out;
  const rules = await loadPenaltyRules(companyId, db);
  if (!rules.some((r) => r.active !== false)) return out;
  const { rows } = await db.query(`
    SELECT employee_id, attendance_date::text AS date, status,
           COALESCE(late_minutes, 0) AS late_minutes, COALESCE(early_leave_minutes, 0) AS early_leave_minutes
      FROM attendance_records
     WHERE employee_id = ANY($1::int[]) AND attendance_date BETWEEN $2::date AND $3::date
       AND deleted_at IS NULL`, [employeeIds.map(Number), from, to]);
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
    byEmp.get(r.employee_id).push(r);
  }
  for (const id of employeeIds) {
    out.set(Number(id), applyRules(rules, byEmp.get(Number(id)) || []));
  }
  return out;
}
