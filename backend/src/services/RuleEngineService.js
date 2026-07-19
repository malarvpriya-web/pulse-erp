/**
 * RuleEngineService — Phase 2 platform layer
 *
 * Evaluates JSONB business rules stored in rules_master against entity data.
 * Rules are non-blocking — evaluation never throws; errors surface as warnings.
 *
 * Exported:
 *   evaluateRules        — run all active rules for a module against an entity
 *   checkInventoryRules  — convenience: run inventory rules across all items
 *   getRulesForModule    — list active rules for a module
 */

import pool from '../config/db.js';
import { flags } from '../config/featureFlags.js';
import { increment } from '../config/metrics.js';

// ── Condition evaluator ───────────────────────────────────────────────────────

function evalCondition(condExpr, entity) {
  if (!condExpr || typeof condExpr !== 'object') return false;
  const { field, operator, value, value_field } = condExpr;
  const lhs = entity[field];
  const rhs = value_field !== undefined ? entity[value_field] : value;

  switch (operator) {
    case 'lt':  return Number(lhs) <  Number(rhs);
    case 'lte': return Number(lhs) <= Number(rhs);
    case 'gt':  return Number(lhs) >  Number(rhs);
    case 'gte': return Number(lhs) >= Number(rhs);
    case 'eq':  return String(lhs) === String(rhs);
    case 'neq': return String(lhs) !== String(rhs);
    case 'in':  return Array.isArray(rhs) ? rhs.includes(lhs) : false;
    case 'nin': return Array.isArray(rhs) ? !rhs.includes(lhs) : true;
    case 'null':    return lhs === null || lhs === undefined;
    case 'notnull': return lhs !== null && lhs !== undefined;
    default:    return false;
  }
}

// Interpolate {{field}} placeholders in a template string
function interpolate(template, entity) {
  if (typeof template !== 'string') return String(template);
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => entity[key] ?? '');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all active rules for `module` against `entity`.
 * @param {string} module — e.g. 'inventory', 'leaves'
 * @param {object} entity — the record being evaluated
 * @param {object} context — optional extra data
 * @returns {Array<{ rule_code, name, triggered, severity, message }>}
 */
export async function evaluateRules(module, entity, context = {}) {
  if (!flags.RULE_ENGINE_ENABLED) return []; // no rules evaluated — all pass
  const { rows: rules } = await pool.query(
    `SELECT * FROM rules_master WHERE module = $1 AND is_active = true ORDER BY priority ASC`,
    [module]
  );

  const results = [];
  for (const rule of rules) {
    try {
      const triggered = evalCondition(rule.condition_expr, { ...entity, ...context });
      const actionExpr = rule.action_expr || {};
      if (triggered) increment('rules_triggered');
      results.push({
        rule_code: rule.code,
        name:      rule.name,
        triggered,
        severity:  triggered ? (actionExpr.severity || 'info') : null,
        message:   triggered ? interpolate(actionExpr.message_template || rule.name, entity) : null,
        action:    triggered ? actionExpr : null,
      });
    } catch {
      results.push({ rule_code: rule.code, name: rule.name, triggered: false, error: true });
    }
  }
  return results;
}

/**
 * Run inventory rules against all active items that have a reorder point set.
 * Returns items that triggered at least one rule.
 */
export async function checkInventoryRules() {
  if (!flags.RULE_ENGINE_ENABLED) return [];
  const { rows: items } = await pool.query(
    `SELECT * FROM inventory_items WHERE is_active = true`
  );

  const alerts = [];
  for (const item of items) {
    const results = await evaluateRules('inventory', item);
    const triggered = results.filter(r => r.triggered);
    if (triggered.length) {
      alerts.push({ item, alerts: triggered });
    }
  }
  return alerts;
}

/**
 * Returns the list of active rules for a module (for admin display / debugging).
 */
export async function getRulesForModule(module) {
  if (!flags.RULE_ENGINE_ENABLED) return [];
  const { rows } = await pool.query(
    `SELECT id, name, code, rule_type, condition_expr, action_expr, priority, description
       FROM rules_master
      WHERE module = $1 AND is_active = true
      ORDER BY priority ASC`,
    [module]
  );
  return rows;
}
