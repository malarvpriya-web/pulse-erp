/**
 * employee-data-quality.mjs — read-only audit of the employee register.
 *
 *   node scripts/hr/employee-data-quality.mjs [companyId]
 *
 * Reports, and changes nothing. Every check corresponds to something the All
 * Employees page or the Employees Dashboard has to work around, so the counts
 * here are the counts those pages display — which is the point: a data problem
 * that only shows up as a strange-looking screen is a data problem nobody fixes.
 *
 * `--report` on backfill-employee-codes.mjs covers the Employee ID checks in
 * more detail; this is the whole-register view.
 */
import 'dotenv/config';
import pool from '../../src/config/db.js';
import { bucketOf, WRITABLE_STATUSES, EXITED_STATUSES } from '../../src/shared/employeeStatus.js';
import { isValidEmployeeCode } from '../../src/shared/employeeCode.js';

const COMPANY_ID = process.argv[2] ? Number(process.argv[2]) : 1;

const { rows } = await pool.query(
  `SELECT id, office_id, first_name, last_name, name, company_email, personal_email,
          department, designation, status, reporting_manager, reporting_manager_id,
          joining_date, dob, exit_date, deleted_at, source_candidate_id, created_at
     FROM employees
    WHERE ($1::int IS NULL OR company_id = $1)
    ORDER BY id`,
  [COMPANY_ID],
);

const current = rows.filter(e => bucketOf(e.status) !== 'Exited' && e.deleted_at == null);
const NULLISH = new Set(['null', 'undefined', 'nan', 'n/a', '-']);
const blank = v => {
  const s = String(v ?? '').trim();
  return !s || NULLISH.has(s.toLowerCase());
};
/** A value that is PRESENT but is a sentinel — the class of bug a falsy check misses. */
const sentinel = v => typeof v === 'string' && NULLISH.has(v.trim().toLowerCase()) && v.trim() !== '';

const ids = r => r.map(e => e.id).join(', ') || '—';
const line = (label, matched, note = '') =>
  console.log(`  ${String(matched.length).padStart(3)}  ${label.padEnd(34)} ${note}${matched.length ? `ids: ${ids(matched)}` : ''}`);

console.log(`\n══ Employee register data quality — company ${COMPANY_ID} ══`);
console.log(`  rows: ${rows.length}   current: ${current.length}   exited: ${rows.length - current.length}   soft-deleted: ${rows.filter(e => e.deleted_at).length}`);

console.log('\n── Mandatory fields (current staff) ──');
line('missing Employee ID',        current.filter(e => blank(e.office_id)));
line('missing Department',         current.filter(e => blank(e.department)));
line('missing Role / Designation', current.filter(e => blank(e.designation)));
line('missing Joining Date',       current.filter(e => e.joining_date == null));

console.log('\n── Employee ID format ──');
// `^EMP[0-9]{3,}$` -- EMP001, the company's own convention -- is the ONLY
// accepted format, enforced by employees_office_id_format. Anything listed here
// is a defect, not a tolerated legacy shape; renumber-employee-codes.mjs fixes it.
const offFormat = rows.filter(e => !blank(e.office_id) && !isValidEmployeeCode(e.office_id));
console.log(`  ${String(offFormat.length).padStart(3)}  NOT in the EMP001 format            ${offFormat.map(e => e.office_id).join(', ') || '\u2014'}`);
// Digit widths in use, so the day the company passes 999 employees and codes
// become EMP1000 is visible here rather than a surprise.
const widths = new Map();
for (const e of rows.filter(r => isValidEmployeeCode(r.office_id))) {
  const w = e.office_id.length - 3;
  widths.set(w, (widths.get(w) ?? 0) + 1);
}
console.log(`       digit widths in use: ${[...widths.entries()].sort().map(([w, n]) => `${w}-digit x${n}`).join(', ') || '\u2014'}`);

console.log('\n── Sentinel strings stored as data ──');
console.log('      (PRESENT but meaningless — a truthiness check passes these through)');
for (const col of ['reporting_manager', 'department', 'designation', 'company_email', 'name']) {
  line(`${col} = 'null'/'undefined'/…`, rows.filter(e => sentinel(e[col])));
}

console.log('\n── Duplicates ──');
const groupDupes = (keyFn) => {
  const m = new Map();
  for (const e of rows) {
    const k = keyFn(e);
    if (k == null) continue;
    (m.get(k) ?? m.set(k, []).get(k)).push(e);
  }
  return [...m.entries()].filter(([, v]) => v.length > 1);
};
const dupeCode  = groupDupes(e => blank(e.office_id) ? null : String(e.office_id).toLowerCase());
const dupeEmail = groupDupes(e => blank(e.company_email) ? null : String(e.company_email).trim().toLowerCase());
const dupeName  = groupDupes(e => {
  const n = `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim().toLowerCase();
  return n ? n : null;
});
for (const [label, groups] of [['duplicate Employee ID', dupeCode], ['duplicate company email', dupeEmail], ['same first+last name', dupeName]]) {
  console.log(`  ${String(groups.length).padStart(3)}  ${label.padEnd(34)}` +
    (groups.length ? groups.map(([k, v]) => `${k} → ids ${v.map(e => e.id).join('/')}`).join('; ') : ''));
}

console.log('\n── Status vocabulary in use ──');
const byStatus = new Map();
for (const e of rows) {
  const k = JSON.stringify(e.status);
  byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
}
for (const [raw, n] of [...byStatus.entries()].sort()) {
  const v = JSON.parse(raw);
  const writable = WRITABLE_STATUSES.includes(v);
  // A status that is READ correctly but cannot be WRITTEN is a legacy spelling:
  // fine to keep, but nothing should be creating more of them.
  const tag = writable ? 'canonical'
    : EXITED_STATUSES.includes(String(v ?? '').toLowerCase()) ? 'legacy exited spelling'
    : 'NOT in the write vocabulary';
  console.log(`  ${String(n).padStart(3)}  ${String(raw).padEnd(20)} → bucket ${bucketOf(v).padEnd(10)} (${tag})`);
}

console.log('\n── Dates ──');
line('joining_date in the future', current.filter(e => e.joining_date && new Date(e.joining_date) > new Date()));
line('exit_date but still current', current.filter(e => e.exit_date != null));
line('dob implies age < 16 or > 75', current.filter(e => {
  if (!e.dob) return false;
  const yrs = (Date.now() - new Date(e.dob).getTime()) / (365.25 * 864e5);
  return yrs < 16 || yrs > 75;
}));

console.log('\n── Reporting line ──');
line('manager NAME set, no manager ID', current.filter(e => !blank(e.reporting_manager) && e.reporting_manager_id == null));
line('reports to themselves',           current.filter(e => e.reporting_manager_id === e.id));

console.log('');
await pool.end();
