/**
 * ValidationEngineService — Phase 2 platform layer
 *
 * Evaluates JSONB validation rules stored in validation_rules against input data.
 * Transparent: if no rules are configured, validation passes.
 *
 * Exported:
 *   validate       — validate a full data object for a module
 *   validateField  — validate a single field
 */

import pool from '../config/db.js';
import { flags } from '../config/featureFlags.js';
import { increment } from '../config/metrics.js';

// ── Rule evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluates one validation_rules row against a value.
 * Returns an error string if the rule fails, or null if it passes.
 */
function evalRule(rule, value) {
  const expr = rule.rule_expr;
  if (!expr || typeof expr !== 'object') return null;

  const absent = value === null || value === undefined ||
                 (typeof value === 'string' && value.trim() === '');
  const str  = absent ? '' : String(value);
  const num  = parseFloat(value);

  // `required` is the ONLY rule that may fire on an absent value.
  if (expr.required && absent) {
    return rule.error_message || `${rule.field_name} is required`;
  }

  // Everything below constrains a value that was SUPPLIED. Firing them on an
  // absent value makes every constraint implicitly required, which is how a
  // `{min: 0}` rule on `budget` came to reject a project update that only
  // changed the status:
  //
  //   PUT /api/projects/projects/1697  {"status":"active"}
  //   → 422  "Project name is required", "Project budget must be a positive number"
  //
  // parseFloat(undefined) is NaN and `NaN < 0` is false, but the guard was
  // written `isNaN(num) || num < expr.min`, so an absent number failed the
  // range check outright. Returning early here is what makes it safe to
  // configure range and length rules for a module without turning every one of
  // its fields into a mandatory field on every update.
  if (absent) return null;

  if (expr.min_length !== undefined && str.length < expr.min_length) {
    return rule.error_message || `${rule.field_name} must be at least ${expr.min_length} characters`;
  }
  if (expr.max_length !== undefined && str.length > expr.max_length) {
    return rule.error_message || `${rule.field_name} must not exceed ${expr.max_length} characters`;
  }
  if (expr.min !== undefined && (isNaN(num) || num < expr.min)) {
    return rule.error_message || `${rule.field_name} must be at least ${expr.min}`;
  }
  if (expr.max !== undefined && (isNaN(num) || num > expr.max)) {
    return rule.error_message || `${rule.field_name} must not exceed ${expr.max}`;
  }
  if (expr.pattern) {
    try {
      if (!new RegExp(expr.pattern).test(str)) {
        return rule.error_message || `${rule.field_name} format is invalid`;
      }
    } catch {
      // Invalid regex in DB — skip this rule
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a data object against the active rules for `module`.
 *
 * @param {string} module
 * @param {object} data
 * @param {{ partial?: boolean, companyId?: number|null }} [opts]
 *   partial   — an UPDATE. Only fields present in the payload are checked, so a
 *               request that changes one field is not asked for the others.
 *               Without this, `required` rules make every update a full replace:
 *               `PUT /projects/:id {"status":"active"}` returned 422 demanding
 *               project_name and budget.
 *   companyId — restrict to this tenant's rules plus the global ones. The table
 *               has a company_id column that nothing was filtering on, so one
 *               tenant's rules were being enforced against every tenant's input.
 *
 * @returns {{ valid: boolean, errors: Array<{ field, message }> }}
 */
export async function validate(module, data, opts = {}) {
  if (!flags.VALIDATION_ENGINE_ENABLED) return { valid: true, errors: [] }; // all input passes
  const { partial = false, companyId = null } = opts;

  const { rows: rules } = await pool.query(
    `SELECT * FROM validation_rules
      WHERE module = $1 AND is_active = true
        AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
      ORDER BY id ASC`,
    [module, companyId]
  );

  const payload = data && typeof data === 'object' ? data : {};
  const errors = [];
  for (const rule of rules) {
    // In partial mode a field the caller did not mention is not their business
    // to satisfy. `hasOwnProperty` rather than a truthiness check, so explicitly
    // clearing a field to '' or null still gets validated.
    if (partial && !Object.prototype.hasOwnProperty.call(payload, rule.field_name)) continue;
    const msg = evalRule(rule, payload[rule.field_name]);
    if (msg) errors.push({ field: rule.field_name, message: msg });
  }

  if (errors.length > 0) increment('validation_failures');
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single field against its active rules for `module`.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export async function validateField(module, fieldName, value) {
  if (!flags.VALIDATION_ENGINE_ENABLED) return { valid: true, errors: [] };
  const { rows: rules } = await pool.query(
    `SELECT * FROM validation_rules WHERE module = $1 AND field_name = $2 AND is_active = true ORDER BY id ASC`,
    [module, fieldName]
  );

  const errors = [];
  for (const rule of rules) {
    const msg = evalRule(rule, value);
    if (msg) errors.push(msg);
  }

  return { valid: errors.length === 0, errors };
}
