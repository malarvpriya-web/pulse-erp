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

  const str  = value !== null && value !== undefined ? String(value) : '';
  const num  = parseFloat(value);

  if (expr.required && (value === null || value === undefined || str.trim() === '')) {
    return rule.error_message || `${rule.field_name} is required`;
  }
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
 * Validate a full data object against all active rules for `module`.
 * @returns {{ valid: boolean, errors: Array<{ field, message }> }}
 */
export async function validate(module, data) {
  if (!flags.VALIDATION_ENGINE_ENABLED) return { valid: true, errors: [] }; // all input passes
  const { rows: rules } = await pool.query(
    `SELECT * FROM validation_rules WHERE module = $1 AND is_active = true ORDER BY id ASC`,
    [module]
  );

  const errors = [];
  for (const rule of rules) {
    const value = data[rule.field_name];
    const msg   = evalRule(rule, value);
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
