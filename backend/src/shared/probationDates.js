/**
 * Probation dates — the ONE rule for when a probation ends.
 *
 * Before this module there were four, and they disagreed about the same
 * employee:
 *   - employee creation wrote joining_date + 90 days into probation_end_date;
 *   - the Probation page ignored that column and showed joining + 180 days
 *     (90 for interns, 120 for trainees);
 *   - the daily reminder job ignored it too and fired on joining + 165 / 180;
 *   - leave fell back to joining + 90 when the column was empty.
 *
 * Now `employees.probation_end_date` is canonical. It is WRITTEN once, from
 * this module, when an employee is created or when HR edits the probation
 * fields, and every reader uses the stored value as-is. Nothing recalculates a
 * period from the joining date at read time.
 *
 * THE CALENDAR-MONTH RULE
 * -----------------------
 * The end date is the LAST DAY of probation, inclusive — the day the employee
 * is still a probationer, so `days_remaining = end - today` is 0 on that day
 * and the dashboard calls it overdue from the next day.
 *
 * An N-month probation starting on day D of month M ends on day D-1 of month
 * M+N — the day before the same calendar date N months later:
 *
 *   joining 01-Jan-2026, 6 months → 30-Jun-2026
 *   joining 15-Jan-2026, 6 months → 14-Jul-2026
 *
 * When that day does not exist in month M+N (a joining day late in a long
 * month), the probation ends on the last day of month M+N:
 *
 *   joining 31-Aug-2026, 6 months → 28-Feb-2027   (no 30-Feb)
 *   joining 30-Aug-2027, 6 months → 29-Feb-2028   (leap year: 29-Feb exists)
 *   joining 29-Feb-2028, 12 months → 28-Feb-2029
 *
 * Plain `+ N months - 1 day` gets the late-month cases wrong in both directions
 * (31-Aug + 6 months clamps to 28-Feb, minus a day is 27-Feb, losing a day), and
 * `+ 180 days` is not six months in any year, which is how the old rules
 * drifted apart in the first place.
 */

export const DEFAULT_PROBATION_MONTHS = 6;
export const DEFAULT_REMINDER_DAYS = 14;
export const MIN_PROBATION_MONTHS = 1;
export const MAX_PROBATION_MONTHS = 24;
export const MAX_REMINDER_DAYS = 90;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (year, month0) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
const iso = (y, m0, d) =>
  `${String(y).padStart(4, '0')}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Parse a calendar date. Accepts 'YYYY-MM-DD' (or a longer ISO string whose
 * first ten characters are one) and a Date, read in UTC. Returns
 * { y, m0, d } or null when it is not a real calendar date — '2026-02-30' is
 * null, not 2-Mar.
 */
export function parseIsoDate(value) {
  if (value == null || value === '') return null;
  let s;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    s = value.toISOString().slice(0, 10);
  } else {
    s = String(value).trim().slice(0, 10);
  }
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]); const m0 = Number(m[2]) - 1; const d = Number(m[3]);
  if (m0 < 0 || m0 > 11 || d < 1 || d > daysInMonth(y, m0)) return null;
  return { y, m0, d };
}

/** Normalise a date to 'YYYY-MM-DD', or null when it is not a real date. */
export function toIsoDate(value) {
  const p = parseIsoDate(value);
  return p ? iso(p.y, p.m0, p.d) : null;
}

/**
 * A probation length in whole months, or null when the value is not one.
 * Strict: '6' and 6 pass, '6.5', 0, 25, 'six' and '' do not.
 */
export function parseProbationMonths(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_PROBATION_MONTHS && n <= MAX_PROBATION_MONTHS ? n : null;
}

/** Reminder lead time in whole days (0..90), or null when the value is not one. */
export function parseReminderDays(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= MAX_REMINDER_DAYS ? n : null;
}

/**
 * Last day of an N-month probation that starts on `startDate` (see the rule
 * above). Returns 'YYYY-MM-DD'. Throws on a bad date or month count: a caller
 * that reaches this with garbage has a bug, and a silently wrong end date is
 * exactly what this module exists to stop.
 */
export function probationEndDate(startDate, months) {
  const start = parseIsoDate(startDate);
  if (!start) throw new RangeError(`"${startDate}" is not a valid date (expected YYYY-MM-DD).`);
  const n = parseProbationMonths(months);
  if (n == null) {
    throw new RangeError(
      `"${months}" is not a valid probation period (whole months, ${MIN_PROBATION_MONTHS}-${MAX_PROBATION_MONTHS}).`);
  }
  const total = start.m0 + n;
  const y = start.y + Math.floor(total / 12);
  const m0 = total % 12;
  const last = daysInMonth(y, m0);
  if (start.d === 1) {
    // The day before the 1st is the last day of the previous month.
    const pm0 = (m0 + 11) % 12;
    const py = m0 === 0 ? y - 1 : y;
    return iso(py, pm0, daysInMonth(py, pm0));
  }
  return iso(y, m0, Math.min(start.d - 1, last));
}

/**
 * The company's probation policy from `company_settings`.
 *
 * The two keys already exist under module 'recruitment' — they were written by
 * the Recruitment Settings screen before that screen hid them for having no
 * consumer. This is the consumer, so they stay where they are: moving them
 * would mean migrating a live row for no behavioural gain.
 *
 * Absent or invalid values fall back to the defaults (6 months, 14 days); the
 * response says which values came from the defaults so a screen can show it.
 */
export async function getProbationPolicy(db, companyId) {
  if (companyId == null) throw new Error('getProbationPolicy requires a company id.');
  const { rows } = await db.query(
    `SELECT settings->>'probation_months'               AS months,
            settings->>'probation_review_reminder_days' AS reminder_days
       FROM company_settings
      WHERE company_id = $1 AND module = 'recruitment'
      LIMIT 1`,
    [companyId],
  );
  const months = parseProbationMonths(rows[0]?.months);
  const reminderDays = parseReminderDays(rows[0]?.reminder_days);
  return {
    probation_months: months ?? DEFAULT_PROBATION_MONTHS,
    reminder_days: reminderDays ?? DEFAULT_REMINDER_DAYS,
    months_is_default: months == null,
    reminder_days_is_default: reminderDays == null,
  };
}

/**
 * The company's reminder lead time in days: its configured
 * probation_review_reminder_days, or 14 when absent/invalid — and 14 for a
 * caller with no company (a global view has no single policy to apply).
 */
export async function reminderDaysFor(db, companyId) {
  if (companyId == null) return DEFAULT_REMINDER_DAYS;
  return (await getProbationPolicy(db, companyId)).reminder_days;
}

/**
 * THE "probation ending soon" window, as SQL: the stored end date falls on a
 * calendar day from today through today + N, both inclusive.
 *
 *   - CALENDAR dates on both sides. A date column compared with NOW() is
 *     compared with a timestamp, and any date is "before now" once the day
 *     has started — so a probation ending TODAY dropped out of a ">= NOW()"
 *     count while the alert beside it counted it.
 *   - Already-ended probations are not "ending soon"; they are overdue, and
 *     the screens that show overdue work count them separately.
 *   - N must already be a validated whole number (0..90); anything else
 *     throws, so the value can be inlined safely.
 *
 * Used by the home alert (dashboard.controller) and the analytics onboarding
 * count, so the two cannot disagree. The reminder job applies the same window
 * with an injectable "today" (jobs/probation.cron.js).
 */
export function probationEndingSoonSql(days, column = 'probation_end_date') {
  const n = parseReminderDays(days);
  if (n == null) throw new RangeError(`"${days}" is not a valid reminder window (whole days, 0-${MAX_REMINDER_DAYS}).`);
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) throw new RangeError(`"${column}" is not a column reference.`);
  return `${column} BETWEEN CURRENT_DATE AND CURRENT_DATE + ${n}`;
}

/**
 * Write the policy. Merges into the existing 'recruitment' settings document
 * (`settings || patch`) so every other recruitment key survives untouched.
 * Validated values only — a caller passes already-parsed numbers or omits them.
 */
export async function saveProbationPolicy(db, companyId, { probation_months, reminder_days } = {}) {
  if (companyId == null) throw new Error('saveProbationPolicy requires a company id.');
  const patch = {};
  if (probation_months !== undefined) patch.probation_months = probation_months;
  if (reminder_days !== undefined) patch.probation_review_reminder_days = reminder_days;
  if (!Object.keys(patch).length) return getProbationPolicy(db, companyId);
  await db.query(
    `INSERT INTO company_settings (company_id, module, settings, updated_at)
     VALUES ($1, 'recruitment', $2::jsonb, NOW())
     ON CONFLICT (company_id, module)
     DO UPDATE SET settings = COALESCE(company_settings.settings, '{}'::jsonb) || EXCLUDED.settings,
                   updated_at = NOW()`,
    [companyId, JSON.stringify(patch)],
  );
  return getProbationPolicy(db, companyId);
}

/**
 * Resolve the probation fields for an employee WRITE.
 *
 * Inputs are the request's values (either may be undefined = not sent):
 *   - `endDate` sent and non-blank  → stored exactly (validated: a real date,
 *     not before the joining date). This is how HR records an end date that
 *     does not follow the standard rule.
 *   - `endDate` not sent, `months` sent → end date calculated from the joining
 *     date and those months.
 *   - neither sent → { touched: false }; the caller must leave both columns
 *     alone. This is what keeps an unrelated edit from rewriting a saved date.
 *     A BLANK value counts as not sent: this path never clears a saved end
 *     date, because "no end date" is the data-quality gap the dashboard
 *     flags, not a state anyone should be able to save by emptying a field.
 *
 * `defaultMonths` is used only when the caller asks for a calculation and no
 * months were sent (the create path). Returns
 *   { touched, probation_months, probation_end_date }  or throws a
 *   RangeError with a user-facing message.
 */
// A value that carries nothing: absent, blank, or the text a FormData append of
// null/undefined produces ('null' / 'undefined').
const isBlank = (v) => v === undefined || v === null
  || ['', 'null', 'undefined'].includes(String(v).trim().toLowerCase());

export function resolveProbationWrite({ joiningDate, months, endDate, defaultMonths = null }) {
  const endSent = !isBlank(endDate);
  const monthsSent = !isBlank(months);
  if (!endSent && !monthsSent && defaultMonths == null) {
    return { touched: false };
  }

  let m = null;
  if (monthsSent) {
    m = parseProbationMonths(months);
    if (m == null) {
      throw new RangeError(
        `Probation period must be a whole number of months between ${MIN_PROBATION_MONTHS} and ${MAX_PROBATION_MONTHS}.`);
    }
  } else if (!endSent) {
    m = parseProbationMonths(defaultMonths) ?? DEFAULT_PROBATION_MONTHS;
  }

  const joined = toIsoDate(joiningDate);
  if (endSent) {
    const end = toIsoDate(endDate);
    if (!end) throw new RangeError(`"${endDate}" is not a valid probation end date. Expected YYYY-MM-DD.`);
    if (joined && end < joined) {
      throw new RangeError(`Probation end date ${end} is before the joining date ${joined}.`);
    }
    // An end date sent WITHOUT months leaves the stored months alone
    // (undefined), rather than clearing a period nobody asked to change.
    return { touched: true, probation_months: monthsSent ? m : undefined, probation_end_date: end };
  }

  if (!joined) {
    throw new RangeError('A probation end date cannot be calculated without a valid joining date.');
  }
  return { touched: true, probation_months: m, probation_end_date: probationEndDate(joined, m) };
}

export default {
  DEFAULT_PROBATION_MONTHS, DEFAULT_REMINDER_DAYS,
  parseIsoDate, toIsoDate, parseProbationMonths, parseReminderDays,
  probationEndDate, getProbationPolicy, saveProbationPolicy, resolveProbationWrite,
};
