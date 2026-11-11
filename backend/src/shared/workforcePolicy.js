/**
 * workforcePolicy.js — company-editable limits used by employee records and
 * Workforce Analytics (2026-11-10).
 *
 * Stored in company_settings under module 'hr' (merge-patched, so other HR keys
 * survive). Every value is an INPUT the company sets on the Workforce Analytics
 * page; the numbers below are only what applies until it does:
 *
 *   min_employee_age     18  — youngest plausible age on the date of birth.
 *                              Cannot be set below 14 (the Child and Adolescent
 *                              Labour Act floor).
 *   max_employee_age     80  — oldest plausible age; catches 1900-style typos.
 *   analytics_min_sample  5  — fewer recorded values than this and a
 *                              Workforce Analytics card shows a list, not a chart.
 *
 * Why it exists: EMP003's date of birth was saved as 27 Feb 2026 (8 months
 * old) and Workforce Analytics counted it as "Under 25". The only check was
 * "not in the future".
 */

export const WORKFORCE_POLICY_MODULE = 'hr';

export const WORKFORCE_POLICY_FIELDS = {
  min_employee_age:     { label: 'Minimum age on date of birth', default: 18, min: 14, max: 25 },
  max_employee_age:     { label: 'Maximum age on date of birth', default: 80, min: 50, max: 100 },
  analytics_min_sample: { label: 'Records needed to draw a chart', default: 5, min: 1, max: 50 },
};

export const WORKFORCE_POLICY_DEFAULTS = Object.fromEntries(
  Object.entries(WORKFORCE_POLICY_FIELDS).map(([k, f]) => [k, f.default]),
);

/** A whole number inside the field's range, or null. */
function parseField(key, value) {
  const f = WORKFORCE_POLICY_FIELDS[key];
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < f.min || n > f.max) return null;
  return n;
}

function policyError(message, errors) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  err.errors = errors;
  return err;
}

/**
 * The company's policy. Absent or invalid stored values fall back to the
 * defaults; `is_default` says which, so the page can show it. A caller with no
 * company (global scope) gets the defaults.
 */
export async function getWorkforcePolicy(db, companyId) {
  let stored = {};
  if (companyId != null) {
    const { rows } = await db.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
      [companyId, WORKFORCE_POLICY_MODULE],
    );
    stored = rows[0]?.settings || {};
  }
  const policy = {};
  const isDefault = {};
  for (const key of Object.keys(WORKFORCE_POLICY_FIELDS)) {
    const v = parseField(key, stored[key]);
    policy[key] = v ?? WORKFORCE_POLICY_DEFAULTS[key];
    isDefault[key] = v == null;
  }
  // A stored pair that crosses (min ≥ max) cannot describe anyone: use defaults.
  if (policy.min_employee_age >= policy.max_employee_age) {
    policy.min_employee_age = WORKFORCE_POLICY_DEFAULTS.min_employee_age;
    policy.max_employee_age = WORKFORCE_POLICY_DEFAULTS.max_employee_age;
    isDefault.min_employee_age = true;
    isDefault.max_employee_age = true;
  }
  return { ...policy, is_default: isDefault };
}

/**
 * Validate a patch. Only keys present are checked; unknown keys are refused so
 * a typo cannot be saved as a setting nobody reads. Throws a 400 listing every
 * problem.
 */
export function validateWorkforcePolicyPatch(patch, current) {
  const errors = [];
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw policyError('Settings must be an object.', ['Settings must be an object.']);
  }
  for (const key of Object.keys(patch)) {
    if (key === 'is_default') continue;
    const f = WORKFORCE_POLICY_FIELDS[key];
    if (!f) { errors.push(`"${key}" is not a workforce setting.`); continue; }
    const v = parseField(key, patch[key]);
    if (v == null) errors.push(`${f.label} must be a whole number from ${f.min} to ${f.max}.`);
    else out[key] = v;
  }
  const min = out.min_employee_age ?? current.min_employee_age;
  const max = out.max_employee_age ?? current.max_employee_age;
  if (!errors.length && min >= max) {
    errors.push(`Minimum age (${min}) must be lower than maximum age (${max}).`);
  }
  if (errors.length) throw policyError(errors.join(' '), errors);
  return out;
}

/** Merge-save; returns the policy as now stored. Requires a company. */
export async function saveWorkforcePolicy(db, companyId, patch) {
  if (companyId == null) throw policyError('Workforce settings need a company.', ['Workforce settings need a company.']);
  const current = await getWorkforcePolicy(db, companyId);
  const clean = validateWorkforcePolicyPatch(patch, current);
  if (Object.keys(clean).length) {
    await db.query(
      `INSERT INTO company_settings (company_id, module, settings, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (company_id, module)
       DO UPDATE SET settings = COALESCE(company_settings.settings, '{}'::jsonb) || EXCLUDED.settings,
                     updated_at = NOW()`,
      [companyId, WORKFORCE_POLICY_MODULE, JSON.stringify(clean)],
    );
  }
  return getWorkforcePolicy(db, companyId);
}

/** Today in the business time zone (process TZ is pinned — timezone.js). */
export function localTodayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole years between two YYYY-MM-DD dates (birthday-aware). */
export function ageOn(dobIso, todayIso) {
  const [by, bm, bd] = dobIso.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/**
 * Why this date of birth cannot be right, or null when it is plausible.
 * Blank is not a problem here (date of birth is optional).
 */
export function dobProblem(dob, policy, todayIso = localTodayIso()) {
  const raw = String(dob ?? '').trim();
  if (!raw) return null;
  const iso = raw.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[3]) {
    return `"${raw}" is not a valid date of birth. Expected YYYY-MM-DD.`;
  }
  if (iso > todayIso) return `Date of birth ${iso} is in the future.`;
  const age = ageOn(iso, todayIso);
  const { min_employee_age: min, max_employee_age: max } = policy;
  if (age < min) {
    return `Date of birth ${iso} makes this employee ${age} years old; the company minimum is ${min} `
      + '(Workforce Analytics → Settings).';
  }
  if (age > max) {
    return `Date of birth ${iso} makes this employee ${age} years old; the company maximum is ${max} `
      + '(Workforce Analytics → Settings).';
  }
  return null;
}
