/**
 * Postgres constraint violations → clean HTTP responses.
 *
 * Route handlers in this codebase almost all end in
 *   `catch (error) { res.status(500).json({ error: error.message }) }`
 * which turns every constraint violation into a 500. Two things follow from that:
 *
 *  1. In production `errorSanitizer.js` rewrites any 5xx body to "Internal server
 *     error", so the user is told nothing actionable — a missing required field
 *     and a genuine crash are indistinguishable.
 *  2. In development the raw Postgres text ("insert or update on table
 *     \"candidates\" violates foreign key constraint ...") is shown verbatim.
 *
 * Neither is a server fault: a bad request deserves a 4xx that says what to fix.
 * This matters more since migration 20260812000004 added the FKs that
 * interview_schedules / offer_letters / candidates.applied_job_id had been missing —
 * input that used to silently insert an orphan row now raises 23503 instead.
 *
 * Deliberately dependency-free. The codebase has no schema-validation framework
 * (no Joi/Zod/yup anywhere), and adding one for a single module would set a
 * pattern the other 59 route files don't follow. This maps what the database
 * already enforces; it is not a substitute for a real request-schema layer.
 */

// Postgres SQLSTATE codes we can turn into something a user can act on.
const PG = {
  UNIQUE_VIOLATION:     '23505',
  FK_VIOLATION:         '23503',
  NOT_NULL_VIOLATION:   '23502',
  CHECK_VIOLATION:      '23514',
  INVALID_TEXT_REPR:    '22P02', // e.g. 'abc' passed where an integer/uuid is expected
  NUMERIC_OVERFLOW:     '22003',
  STRING_TOO_LONG:      '22001',
};

// Constraint name → human sentence. Anything absent falls back to a generic
// message for its code, so an unmapped constraint still yields a 4xx, never a 500.
const CONSTRAINT_MESSAGES = {
  candidates_company_email_uniq: 'A candidate with this email already exists for your company.',
  employees_source_candidate_uniq: 'An employee record has already been created for this candidate.',
  candidates_current_stage_check: 'That is not a valid pipeline stage.',
};

// Column → label, so "null value in column \"job_title\"" reads as "Job title is required."
function humanizeColumn(col) {
  if (!col) return 'A required field';
  return col
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

// 23503/23505 don't populate err.column — the offending column is only in
// err.detail, e.g. `Key (applied_job_id)=(99) is not present in table "job_openings".`
// Fall back to the constraint name (`candidates_applied_job_id_fkey`) when detail
// is absent, and to err.column last.
function offendingColumn(err) {
  const fromDetail = /Key \(([^)]+)\)/.exec(err.detail || '');
  if (fromDetail) return fromDetail[1].split(',')[0].trim();
  const fromConstraint = /^[a-z0-9]+_(.+?)_(fkey|key|uniq|check)$/.exec(err.constraint || '');
  if (fromConstraint) return fromConstraint[1];
  return err.column || null;
}

/**
 * Map an error to { status, message }, or null when it isn't a Postgres
 * constraint violation (caller should treat those as a genuine 500).
 *
 * An explicit `err.statusCode` always wins — handlers that already classified
 * their own error (404 not found, 409 already-accepted) keep that classification.
 */
export function httpFromPgError(err) {
  if (!err) return null;
  if (err.statusCode || err.status) {
    return { status: err.statusCode || err.status, message: err.message };
  }

  const named = err.constraint && CONSTRAINT_MESSAGES[err.constraint];

  switch (err.code) {
    case PG.UNIQUE_VIOLATION:
      return { status: 409, message: named || 'That record already exists.' };

    case PG.FK_VIOLATION:
      // 23503 means the referenced row isn't there — a bad id in the request.
      return {
        status: 400,
        message: named || `${humanizeColumn(offendingColumn(err))} refers to a record that does not exist.`,
      };

    case PG.NOT_NULL_VIOLATION:
      // 23502 does populate err.column.
      return { status: 400, message: `${humanizeColumn(err.column)} is required.` };

    case PG.CHECK_VIOLATION:
      return { status: 400, message: named || 'One of the submitted values is not allowed.' };

    case PG.INVALID_TEXT_REPR:
      return { status: 400, message: 'One of the submitted values is the wrong type.' };

    case PG.NUMERIC_OVERFLOW:
      return { status: 400, message: 'A numeric value is out of range.' };

    case PG.STRING_TOO_LONG:
      return { status: 400, message: 'A submitted value is too long.' };

    default:
      return null;
  }
}

/**
 * Drop-in replacement for `res.status(500).json({ error: error.message })`.
 * Classifies constraint violations as 4xx; anything unrecognised still 500s and
 * is left for errorSanitizer/errorHandler to scrub and log as before.
 */
export function respondError(res, err) {
  const mapped = httpFromPgError(err);
  if (mapped) return res.status(mapped.status).json({ error: mapped.message });
  return res.status(500).json({ error: err?.message ?? 'Internal server error' });
}
