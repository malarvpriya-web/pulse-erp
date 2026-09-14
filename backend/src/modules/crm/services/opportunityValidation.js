/**
 * opportunityValidation.js — the one place an opportunity is checked before it
 * is written.
 *
 * WHY
 * ---
 * `crm_settings.required_fields_to_close` has held `['value','expected_close_date']`
 * for this deployment since the settings screen shipped, and the Salesforce-parity
 * audit (2026-09-03) found it enforced almost nowhere:
 *
 *   - FIVE code paths create an opportunity: crm.routes POST /opportunities,
 *     crm.routes POST /leads/:id/convert, opportunities.repository.create(),
 *     ceo-intelligence POST /customers/:partyId/convert-upsell, and
 *     tenders.routes. Exactly ONE of them read the setting.
 *   - That one checked `expected_close_date` and ignored `value`, so half the
 *     configured rule was decoration.
 *   - Its lookup was wrapped in `catch (_) {}`, so any error reading crm_settings
 *     skipped validation silently rather than failing closed.
 *
 * The consequence is visible in the data: 4 of 9 opportunities in this database
 * have a NULL expected_closing_date, including both Won deals worth ₹51.9M
 * between them. An opportunity with no close date belongs to no period, so it
 * is invisible to every forecast, every ageing report and every
 * revenue-by-month chart — it does not read as an error anywhere, it simply
 * never appears.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a schema NOT NULL. The requirement is per-company configuration, and
 * companies that have not opted in must keep being able to log a bare
 * opportunity. A CHECK constraint would also break the historical rows rather
 * than stopping new bad ones.
 */

const FIELD_LABELS = {
  value:                'Expected value',
  expected_close_date:  'Expected closing date',
  account:              'Customer account',
  stage:                'Stage',
  probability:          'Probability',
  next_step:            'Next step',
};

/** Maps a configured requirement key to the payload field(s) that satisfy it. */
const FIELD_SOURCES = {
  value:               (p) => p.expected_value ?? p.estimate_value,
  expected_close_date: (p) => p.expected_closing_date,
  account:             (p) => p.account_id,
  stage:               (p) => p.stage,
  probability:         (p) => p.probability_percentage,
  next_step:           (p) => p.next_step,
};

const isBlank = (v) => v === null || v === undefined || v === '' ||
                       (typeof v === 'string' && v.trim() === '');

/**
 * Read the configured requirements for a company.
 *
 * Deliberately NOT wrapped in a swallow-everything catch: if crm_settings
 * cannot be read the caller must see the error, because "validation was skipped
 * because a query failed" is indistinguishable from "validation passed" to
 * everything downstream. A company with no settings row has no requirements,
 * which is a real answer and returns [].
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number|null} companyId
 * @returns {Promise<string[]>}
 */
export async function requiredOpportunityFields(db, companyId) {
  if (companyId == null) return [];
  const { rows } = await db.query(
    `SELECT required_fields_to_close FROM crm_settings WHERE company_id = $1`,
    [companyId]
  );
  const raw = rows[0]?.required_fields_to_close;
  return Array.isArray(raw) ? raw.filter((f) => typeof f === 'string') : [];
}

/**
 * Validate a payload against the company's configured requirements plus the
 * invariants that hold regardless of configuration.
 *
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function validateOpportunity(db, companyId, payload = {}) {
  const errors = [];

  // Unconditional invariants — these are not opinions about sales process.
  if (isBlank(payload.opportunity_name)) {
    errors.push('Opportunity name is required');
  }
  for (const [field, label] of [['expected_value', 'Expected value'], ['estimate_value', 'Estimate value']]) {
    const v = payload[field];
    if (!isBlank(v) && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
      errors.push(`${label} must be a non-negative number`);
    }
  }
  const prob = payload.probability_percentage;
  if (!isBlank(prob) && (!Number.isFinite(Number(prob)) || Number(prob) < 0 || Number(prob) > 100)) {
    errors.push('Probability must be between 0 and 100');
  }

  // Per-company configured requirements.
  const required = await requiredOpportunityFields(db, companyId);
  for (const key of required) {
    const read = FIELD_SOURCES[key];
    if (!read) continue;                       // unknown key in settings — ignore, don't crash
    if (isBlank(read(payload))) {
      errors.push(`${FIELD_LABELS[key] || key} is required (configured in CRM settings)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Throwing wrapper for route handlers: `await assertValidOpportunity(...)` and
 * let the shared error path turn `status` into the response code.
 */
export async function assertValidOpportunity(db, companyId, payload = {}) {
  const { ok, errors } = await validateOpportunity(db, companyId, payload);
  if (!ok) {
    throw Object.assign(new Error(errors.join('; ')), { status: 400, validationErrors: errors });
  }
}

export default { requiredOpportunityFields, validateOpportunity, assertValidOpportunity };
