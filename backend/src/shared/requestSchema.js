/**
 * Minimal request-body validation.
 *
 * Companion to shared/pgErrors.js, which maps constraint violations the database
 * already raises. That file's header notes what it deliberately does not do:
 *
 *   "This maps what the database already enforces; it is not a substitute for a
 *    real request-schema layer."
 *
 * This is that layer. Two gaps make it worth having:
 *
 *  1. Input the database accepts but the application shouldn't. `job_requisitions.status`
 *     is a bare varchar(30) with no CHECK, so `status: "banana"` inserts happily and
 *     then renders as an unknown badge on every page that reads it. Same for
 *     `job_openings.status` (varchar 20) and `offer_letters.offer_status` (varchar 20).
 *     The canonical vocabularies live in the frontend's
 *     `features/recruitment/shared/constants.js`; the enums here mirror them.
 *  2. Input that reaches Postgres as the wrong type and surfaces as raw SQLSTATE text.
 *     pgErrors turns that into a 400, but a generic one ("One of the submitted values
 *     is the wrong type") that doesn't name the field. Catching it here names it.
 *
 * Deliberately dependency-free, for the reason pgErrors.js gives: the codebase has no
 * schema-validation framework, and adding Joi/Zod for one module would set a pattern
 * the other 59 route files don't follow. This is ~120 lines with no install, and any
 * route file can adopt it incrementally.
 *
 * Non-mutating by design. Validation only reads req.body — it never coerces, trims or
 * strips. Handlers spread `req.body` straight into repository calls that rely on
 * pickUpdatable() for mass-assignment safety (see shared/safeUpdate.js), and silently
 * rewriting values under them would be a behaviour change dressed up as validation.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE  = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Field name → human label, matching pgErrors.js's humanizeColumn(). */
function labelFor(name, rule) {
  if (rule.label) return rule.label;
  return name
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

/**
 * A value counts as "not supplied" when it is absent, null, or an empty string.
 *
 * The empty-string case is load-bearing: every form in this module posts its whole
 * state object, so untouched optional inputs arrive as `''` rather than being omitted.
 * Treating `''` as a supplied value would reject requests that work correctly today.
 */
function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** @returns {string|null} an error sentence, or null when the value is acceptable. */
function checkValue(label, rule, value) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return `${label} must be text.`;
      if (rule.max && value.length > rule.max) {
        return `${label} must be ${rule.max} characters or fewer.`;
      }
      if (rule.min && value.trim().length < rule.min) {
        return `${label} must be at least ${rule.min} characters.`;
      }
      return null;
    }

    case 'int':
    case 'number': {
      // Form posts arrive as strings ("5"), so Number() is the right test, not typeof.
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) return `${label} must be a number.`;
      if (rule.type === 'int' && !Number.isInteger(n)) return `${label} must be a whole number.`;
      if (rule.min !== undefined && n < rule.min) return `${label} must be ${rule.min} or more.`;
      if (rule.max !== undefined && n > rule.max) return `${label} must be ${rule.max} or less.`;
      return null;
    }

    case 'bool': {
      if (typeof value === 'boolean') return null;
      if (['true', 'false', '1', '0'].includes(String(value))) return null;
      return `${label} must be true or false.`;
    }

    case 'enum': {
      if (!rule.values.includes(value)) {
        return `${label} must be one of: ${rule.values.join(', ')}.`;
      }
      return null;
    }

    case 'email':
      return EMAIL_RE.test(String(value)) ? null : `${label} must be a valid email address.`;

    case 'uuid':
      return UUID_RE.test(String(value)) ? null : `${label} must be a valid id.`;

    case 'date': {
      const s = String(value);
      // Accept a full ISO timestamp too — <input type="date"> sends YYYY-MM-DD, but
      // some callers pass a serialised Date. Both land in a DATE column fine.
      const datePart = s.length > 10 && !Number.isNaN(Date.parse(s)) ? s.slice(0, 10) : s;
      if (!DATE_RE.test(datePart)) return `${label} must be a date (YYYY-MM-DD).`;
      return Number.isNaN(Date.parse(datePart)) ? `${label} is not a real date.` : null;
    }

    case 'time':
      return TIME_RE.test(String(value)) ? null : `${label} must be a time (HH:MM).`;

    case 'array': {
      if (Array.isArray(value)) return null;
      // A multipart form cannot carry an array, so callers JSON-encode it: the
      // add-candidate path in ResumeDatabase.jsx posts JSON.stringify(skills)
      // through FormData, while its own edit path sends a real array in a JSON
      // body. Both are legitimate and both must pass.
      if (typeof value === 'string') {
        try {
          return Array.isArray(JSON.parse(value)) ? null : `${label} must be a list.`;
        } catch {
          return `${label} must be a list.`;
        }
      }
      return `${label} must be a list.`;
    }

    default:
      return null;
  }
}

/**
 * Validate an object against a schema.
 * @param {object} body
 * @param {Record<string, object>} schema  field → rule
 * @param {{ partial?: boolean }} opts     partial skips `required` (PUT/PATCH)
 * @returns {Record<string, string>} field → error sentence; empty when valid
 */
export function validateObject(body, schema, { partial = false } = {}) {
  const errors = {};
  const src = body && typeof body === 'object' ? body : {};

  for (const [name, rule] of Object.entries(schema)) {
    const label = labelFor(name, rule);
    const value = src[name];

    if (isBlank(value)) {
      if (rule.required && !partial) errors[name] = `${label} is required.`;
      continue;
    }
    const err = checkValue(label, rule, value);
    if (err) errors[name] = err;
  }
  return errors;
}

/**
 * Express middleware. Responds 400 on the first invalid request and does not call next().
 *
 * The body shape matches what respondError() produces (`{ error }`) so existing
 * frontend error handling keeps working unchanged, with `fields` added for forms
 * that want to highlight individual inputs.
 */
export function validateBody(schema, opts = {}) {
  return function validateBodyMiddleware(req, res, next) {
    const errors = validateObject(req.body, schema, opts);
    const names = Object.keys(errors);
    if (names.length === 0) return next();

    return res.status(400).json({
      error: names.length === 1
        ? errors[names[0]]
        : `${errors[names[0]]} (and ${names.length - 1} other problem${names.length > 2 ? 's' : ''})`,
      fields: errors,
    });
  };
}

/** `validateBody(schema, { partial: true })` — the PUT/PATCH form. */
export function validatePatch(schema) {
  return validateBody(schema, { partial: true });
}
