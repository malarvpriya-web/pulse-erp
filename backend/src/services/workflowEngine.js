/**
 * workflowEngine.js — evaluate workflow conditions and execute workflow actions.
 *
 * WHAT REPLACED WHAT
 * ------------------
 * `POST /api/workflows/:id/trigger` used to bump a counter, write a run log with
 * a hardcoded status of 'completed', and return the rule's actions under the key
 * `simulated_actions`. It never read `conditions` and never performed an action,
 * and no business code anywhere called it — so a rule saved in the Workflow
 * Builder had no effect on anything, while its run-log page filled with
 * successes. This module is the part that was missing.
 *
 * DESIGN
 * ------
 * Two halves, deliberately separable:
 *
 *   evaluateConditions(spec, context) — PURE. No database, no clock, no I/O.
 *     That is what makes the rule language testable without fixtures, and it is
 *     the half most likely to be wrong in a way nobody notices.
 *
 *   executeActions(...) — effectful, and every effect goes through the ACTIONS
 *     registry. A rule cannot name an action the registry does not implement:
 *     an unknown action is a recorded FAILURE, never a silent skip. The old
 *     endpoint's habit of reporting success for work it did not do is the exact
 *     failure this guards against.
 *
 * FAILURE SEMANTICS
 * -----------------
 * Actions are independent. One failing does not abort the rest — a rule that
 * notifies a manager and creates a task should still create the task when the
 * notification fails — and every outcome is recorded per action in
 * workflow_run_logs.actions_result. The run's overall status is:
 *
 *   'completed'  every action succeeded
 *   'partial'    at least one succeeded and at least one failed
 *   'failed'     every action failed, or evaluation itself threw
 *   'skipped'    conditions did not hold (NOT a failure — see `matched`)
 *
 * `matched` is stored separately from `status` on purpose. "The rule correctly
 * decided not to fire" and "the rule broke" are different answers to
 * "why didn't my automation run", and a single status column cannot say both.
 *
 * TENANCY
 * -------
 * Every dispatch is scoped by company_id. workflow_rules had no such column
 * until migration 20260903000023; the dispatcher will not run a rule whose
 * company does not match the triggering record's, and refuses to dispatch at
 * all without a company scope rather than falling open across tenants.
 */

import pool from '../config/db.js';

/* ══════════════════════════════════════════════════════════════════════════
   Condition evaluation — pure
   ══════════════════════════════════════════════════════════════════════════ */

/** Read `a.b.c` out of a context object. Returns undefined for any missing hop. */
export function readPath(context, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce(
    (acc, key) => (acc == null ? undefined : acc[key]),
    context
  );
}

const asNumber = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v);
};

const asText = (v) => (v === null || v === undefined ? '' : String(v).trim().toLowerCase());

const isEmpty = (v) =>
  v === null || v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/**
 * The operator table. Every operator must handle a missing left-hand value
 * without throwing — a condition on a field the record does not carry is a
 * normal occurrence, not an error.
 */
export const OPERATORS = {
  equals:            (a, b) => asText(a) === asText(b),
  not_equals:        (a, b) => asText(a) !== asText(b),
  greater_than:      (a, b) => Number.isFinite(asNumber(a)) && Number.isFinite(asNumber(b)) && asNumber(a) >  asNumber(b),
  greater_or_equal:  (a, b) => Number.isFinite(asNumber(a)) && Number.isFinite(asNumber(b)) && asNumber(a) >= asNumber(b),
  less_than:         (a, b) => Number.isFinite(asNumber(a)) && Number.isFinite(asNumber(b)) && asNumber(a) <  asNumber(b),
  less_or_equal:     (a, b) => Number.isFinite(asNumber(a)) && Number.isFinite(asNumber(b)) && asNumber(a) <= asNumber(b),
  contains:          (a, b) => asText(a).includes(asText(b)),
  not_contains:      (a, b) => !asText(a).includes(asText(b)),
  starts_with:       (a, b) => asText(a).startsWith(asText(b)),
  in:                (a, b) => (Array.isArray(b) ? b : String(b ?? '').split(',')).map(asText).includes(asText(a)),
  not_in:            (a, b) => !(Array.isArray(b) ? b : String(b ?? '').split(',')).map(asText).includes(asText(a)),
  is_empty:          (a) => isEmpty(a),
  is_not_empty:      (a) => !isEmpty(a),
  // `changed` needs the before-image, which the dispatcher puts at context.previous.
  changed:           (a, _b, ctx, field) => asText(a) !== asText(readPath(ctx, `previous.${field}`)),
};

// Aliases so rules written against the Workflow Builder's older vocabulary keep
// evaluating. An unrecognised operator is an ERROR, not a silent false — a rule
// that quietly never matches is the worst outcome here.
const OPERATOR_ALIASES = {
  eq: 'equals', ne: 'not_equals', gt: 'greater_than', gte: 'greater_or_equal',
  lt: 'less_than', lte: 'less_or_equal', '=': 'equals', '!=': 'not_equals',
  '>': 'greater_than', '>=': 'greater_or_equal', '<': 'less_than', '<=': 'less_or_equal',
  empty: 'is_empty', not_empty: 'is_not_empty',
};

function resolveOperator(name) {
  const key = String(name ?? 'equals').trim().toLowerCase();
  const resolved = OPERATOR_ALIASES[key] ?? key;
  const fn = OPERATORS[resolved];
  if (!fn) throw Object.assign(new Error(`Unknown workflow operator: ${name}`), { status: 400 });
  return fn;
}

/**
 * Evaluate a condition spec against a context.
 *
 * Accepts three shapes, because three already exist in the database and in the
 * Workflow Builder's payloads:
 *
 *   []                              — no conditions. Matches. An empty rule is
 *                                     an unconditional rule, which is what a
 *                                     user who wrote no conditions meant.
 *   [{field, operator, value, logic}] — flat list; `logic` ('AND'|'OR') on each
 *                                     entry joins it to the NEXT one.
 *   {op:'eq', field, value}          — the seeder's single-condition object.
 *   {all:[...]} / {any:[...]}        — nestable groups.
 *
 * @returns {boolean}
 */
export function evaluateConditions(spec, context = {}) {
  if (spec == null) return true;

  // Group form
  if (!Array.isArray(spec) && typeof spec === 'object') {
    if (Array.isArray(spec.all)) return spec.all.every((s) => evaluateConditions(s, context));
    if (Array.isArray(spec.any)) return spec.any.some((s) => evaluateConditions(s, context));
    if (Array.isArray(spec.conditions)) return evaluateConditions(spec.conditions, context);
    // Single-condition object, incl. the seeder's {op, field, value}.
    return evaluateOne(spec, context);
  }

  if (!Array.isArray(spec) || spec.length === 0) return true;

  // Flat list with per-entry logic joining to the next. Evaluated left to right;
  // this is what the Workflow Builder emits and it has no precedence concept,
  // so neither does this — nesting is available through {all}/{any} instead.
  let result = evaluateOne(spec[0], context);
  for (let i = 1; i < spec.length; i++) {
    const joiner = String(spec[i - 1].logic ?? 'AND').toUpperCase();
    const next = evaluateOne(spec[i], context);
    result = joiner === 'OR' ? (result || next) : (result && next);
  }
  return result;
}

function evaluateOne(cond, context) {
  if (cond == null) return true;
  if (Array.isArray(cond) || cond.all || cond.any) return evaluateConditions(cond, context);

  const field = cond.field ?? cond.path;
  const fn = resolveOperator(cond.operator ?? cond.op);
  const left = readPath(context, field);
  return Boolean(fn(left, cond.value, context, field));
}

/* ══════════════════════════════════════════════════════════════════════════
   Actions
   ══════════════════════════════════════════════════════════════════════════ */

/** `{{field.path}}` interpolation against the context. */
export function renderTemplate(text, context) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const v = readPath(context, path);
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Columns each module allows a workflow to write. A workflow that can set any
 * column on any table is a mass-assignment primitive with a UI on it, so the
 * update action is whitelisted the same way safeUpdate's pickUpdatable() is.
 */
const UPDATABLE = {
  leads:         new Set(['status', 'lead_score', 'assigned_to', 'notes', 'probability']),
  opportunities: new Set(['stage', 'probability_percentage', 'next_step', 'assigned_to', 'forecast_category']),
  support_tickets: new Set(['status', 'priority', 'assigned_to']),
  quotations:    new Set(['status']),
  sales_orders:  new Set(['order_status']),
};

/**
 * The action registry. Each entry receives ({ config, context, run }) and
 * returns a plain result object that is stored verbatim in
 * workflow_run_logs.actions_result.
 */
export const ACTIONS = {
  async notify({ config, context, run }) {
    const title = renderTemplate(config.title ?? config.subject ?? 'Workflow notification', context);
    const body  = renderTemplate(config.body  ?? config.message ?? '', context);

    const recipients = await resolveRecipients(config, run.companyId);
    if (!recipients.length) {
      // A notification with nobody to send to is a real failure, not a no-op —
      // silently succeeding here is how "the automation ran" stops meaning
      // "someone was told".
      throw new Error(`No recipients resolved for role/user ${config.to_role ?? config.to_user_id ?? '(unspecified)'}`);
    }
    for (const userId of recipients) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
         VALUES ($1,$2,$3,$4,$5,'workflow')`,
        [userId, title, body, run.module, run.entityId != null ? String(run.entityId) : null]
      );
    }
    return { notified_user_ids: recipients, title };
  },

  async create_task({ config, context, run }) {
    const title = renderTemplate(config.title ?? 'Workflow task', context);
    const offsetDays = Number(config.due_date_offset ?? config.due_in_days ?? 3);
    const due = new Date(Date.now() + (Number.isFinite(offsetDays) ? offsetDays : 3) * 86400000)
      .toISOString().split('T')[0];

    // crm_activities is the CRM task/activity table; performed_by FKs employees.
    const { rows: [row] } = await pool.query(
      `INSERT INTO crm_activities
         (company_id, activity_type, subject, description, activity_date,
          lead_id, opportunity_id, account_id, status, next_followup_date, performed_by)
       VALUES ($1,'task',$2,$3,NOW(),$4,$5,$6,'planned',$7,$8)
       RETURNING id`,
      [run.companyId, title, renderTemplate(config.body ?? '', context),
       run.module === 'lead' ? run.entityId : null,
       run.module === 'opportunity' ? run.entityId : null,
       config.account_id ?? null, due,
       config.assignee_employee_id ?? readPath(context, 'record.assigned_to') ?? null]
    );
    return { activity_id: row.id, due_date: due };
  },

  async update_field({ config, run }) {
    const table = String(config.table ?? run.table ?? '').trim();
    const field = String(config.field ?? '').trim();
    const allowed = UPDATABLE[table];
    if (!allowed) throw new Error(`Workflow updates are not permitted on table "${table || '(unset)'}"`);
    if (!allowed.has(field)) {
      throw new Error(`Field "${field}" is not workflow-updatable on ${table} (allowed: ${[...allowed].join(', ')})`);
    }
    if (run.entityId == null) throw new Error('update_field needs an entity id');

    // Table and column are whitelist members, never caller text, so they are
    // safe to interpolate; the VALUE is always bound.
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET ${field} = $1, updated_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)`,
      [config.value ?? null, run.entityId, run.companyId]
    );
    if (!rowCount) throw new Error(`No ${table} row ${run.entityId} in company ${run.companyId}`);
    return { table, field, value: config.value ?? null, rows_updated: rowCount };
  },

  async assign({ config, run }) {
    const table = String(config.table ?? run.table ?? '').trim();
    if (!UPDATABLE[table]?.has('assigned_to')) throw new Error(`assign is not permitted on table "${table}"`);
    const employeeId = config.employee_id ?? null;
    if (employeeId == null) throw new Error('assign needs config.employee_id (an employees.id)');
    // assigned_to FKs employees on every table in the whitelist; verify before
    // writing so the failure is a clear message rather than a raw 23503.
    const { rows } = await pool.query(`SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL`, [employeeId]);
    if (!rows.length) throw new Error(`Employee ${employeeId} does not exist`);
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET assigned_to = $1, updated_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)`,
      [employeeId, run.entityId, run.companyId]
    );
    if (!rowCount) throw new Error(`No ${table} row ${run.entityId} in company ${run.companyId}`);
    return { table, assigned_to: employeeId };
  },

  async log({ config, context }) {
    // Explicit no-op for rules that only need an execution record.
    return { message: renderTemplate(config.message ?? 'logged', context) };
  },
};

/**
 * Resolve `to_role` / `to_user_id` to users.id values, scoped to the company.
 *
 * Roles come from the user_roles junction, never the legacy flat users.role
 * column — roles are many-to-many here, and reading the flat column misses
 * every user whose primary role is not the one named.
 */
async function resolveRecipients(config, companyId) {
  if (config.to_user_id) return [Number(config.to_user_id)];

  const roles = (Array.isArray(config.to_role) ? config.to_role : [config.to_role])
    .filter(Boolean)
    .map((r) => String(r).trim().toLowerCase());
  if (!roles.length) return [];

  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r       ON r.id = ur.role_id
      WHERE u.is_active = true
        AND LOWER(r.code) = ANY($1)
        AND ($2::int IS NULL OR u.company_id = $2 OR u.company_id IS NULL)`,
    [roles, companyId]
  );
  return rows.map((r) => r.id);
}

/* ══════════════════════════════════════════════════════════════════════════
   Dispatch
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Run one rule against one record.
 *
 * @param {object} rule  a workflow_rules row
 * @param {object} opts  { companyId, module, event, entityId, table, record, previous, actorUserId, attempt }
 * @returns {Promise<object>} the run-log row that was written
 */
export async function runRule(rule, opts) {
  const started = Date.now();
  const run = {
    companyId: opts.companyId ?? null,
    module: opts.module ?? rule.trigger_module ?? null,
    event: opts.event ?? rule.trigger_event ?? null,
    entityId: opts.entityId ?? null,
    table: opts.table ?? null,
  };
  const context = {
    record: opts.record ?? {},
    previous: opts.previous ?? {},
    event: run.event,
    module: run.module,
    // Flattened so a rule can say `status` instead of `record.status` — that is
    // how every condition already stored in workflow_rules is written.
    ...(opts.record ?? {}),
  };

  let matched = false;
  let status = 'failed';
  let actionsResult = [];
  let errorMessage = null;

  try {
    matched = evaluateConditions(rule.conditions, context);

    if (!matched) {
      status = 'skipped';
    } else {
      const actions = normaliseActions(rule.actions);
      if (!actions.length) {
        // A matching rule with no actions did nothing, and saying 'completed'
        // would claim otherwise.
        status = 'skipped';
        actionsResult = [{ type: null, status: 'skipped', error: 'rule has no actions' }];
      } else {
        actionsResult = await executeActions(actions, { context, run });
        const ok = actionsResult.filter((r) => r.status === 'ok').length;
        status = ok === actionsResult.length ? 'completed' : (ok > 0 ? 'partial' : 'failed');
      }
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err.message;
  }

  const { rows: [log] } = await pool.query(
    `INSERT INTO workflow_run_logs
       (workflow_id, company_id, status, matched, entity_id, entity_module,
        duration_ms, trigger_data, actions_result, error_message, attempt, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [rule.id, run.companyId, status, matched, run.entityId, run.module,
     Date.now() - started, JSON.stringify({ event: run.event, record: opts.record ?? null }),
     JSON.stringify(actionsResult), errorMessage,
     opts.attempt ?? 1, opts.actorUserId ?? null]
  );

  // trigger_count counts rules that actually FIRED. Counting evaluations would
  // make an unmatched rule look busy — the old endpoint incremented on every
  // call regardless, which is why every SEED rule showed a trigger history.
  if (matched) {
    await pool.query(
      `UPDATE workflow_rules SET last_triggered_at = NOW(), trigger_count = COALESCE(trigger_count,0) + 1
        WHERE id = $1`,
      [rule.id]
    );
  }

  return log;
}

/** Actions may be stored as an array, a single object, or a bare string name. */
function normaliseActions(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((a) => (typeof a === 'string' ? { type: a, config: {} } : a))
    .filter((a) => a && (a.type || a.action))
    .map((a) => ({ type: String(a.type ?? a.action), config: a.config ?? a.params ?? {} }));
}

/**
 * Execute actions independently, recording each outcome.
 *
 * Retries are per-action and only for errors that can plausibly succeed on a
 * second attempt. A validation failure ("field X is not updatable") is
 * deterministic; retrying it just writes the same error three times and delays
 * the run.
 */
async function executeActions(actions, { context, run }, maxAttempts = 2) {
  const results = [];
  for (const action of actions) {
    const type = normaliseActionType(action.type);
    const fn = ACTIONS[type];
    if (!fn) {
      // An action the engine cannot perform is a FAILURE. The replaced endpoint
      // returned every action under `simulated_actions` and called the run a
      // success, which is how a rule naming a nonexistent action looked healthy.
      results.push({ type: action.type, status: 'error', error: `Unknown action type "${action.type}"` });
      continue;
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const out = await fn({ config: action.config ?? {}, context, run });
        results.push({ type, status: 'ok', attempt, result: out });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === maxAttempts) break;
      }
    }
    if (lastErr) results.push({ type, status: 'error', error: lastErr.message, attempts: maxAttempts });
  }
  return results;
}

const ACTION_ALIASES = {
  'send notification': 'notify', send_notification: 'notify', notification: 'notify',
  'send email': 'notify', send_email: 'notify', email: 'notify',
  'create task': 'create_task', task: 'create_task',
  'update field': 'update_field', update: 'update_field', 'change status': 'update_field',
  'assign to': 'assign', assign_to: 'assign',
};

function normaliseActionType(type) {
  const key = String(type ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return ACTION_ALIASES[key] ?? key.replace(/\s+/g, '_');
}

/**
 * Only transient faults are worth a second attempt. Postgres connection and
 * serialization classes qualify; a constraint violation or a whitelist rejection
 * will fail identically forever.
 */
function isRetryable(err) {
  const transient = ['08000', '08003', '08006', '40001', '40P01', '57P01', '53300'];
  return transient.includes(err?.code) || /ECONNRESET|ETIMEDOUT|Connection terminated/i.test(err?.message ?? '');
}

/**
 * Fire every active rule registered for (company, module, event).
 *
 * The one call business code makes. Never throws: automation must not be able
 * to fail a business transaction it was only observing. Failures land in
 * workflow_run_logs, which is the whole reason that table has an error column.
 *
 * @returns {Promise<object[]>} the run logs written (empty when no rule matched the trigger)
 */
export async function dispatch({ companyId, module, event, entityId = null, table = null, record = {}, previous = {}, actorUserId = null }) {
  try {
    if (companyId == null) {
      // Refusing is deliberate. Dispatching with a null company would run every
      // tenant's rules against this record — the same fail-open shape the
      // company_id predicate has elsewhere.
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), level: 'WARN', event: 'workflow_dispatch_no_scope',
        module, trigger: event, message: 'dispatch called without a company scope — skipped',
      }));
      return [];
    }

    const { rows: rules } = await pool.query(
      `SELECT * FROM workflow_rules
        WHERE is_active = true
          AND company_id = $1
          AND LOWER(trigger_module) = LOWER($2)
          AND LOWER(trigger_event)  = LOWER($3)
        ORDER BY priority ASC, id ASC`,
      [companyId, module, event]
    );
    if (!rules.length) return [];

    const logs = [];
    for (const rule of rules) {
      logs.push(await runRule(rule, { companyId, module, event, entityId, table, record, previous, actorUserId }));
    }
    return logs;
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'ERROR', event: 'workflow_dispatch_failed',
      module, trigger: event, entityId, message: err.message,
    }));
    return [];
  }
}

export default {
  OPERATORS, ACTIONS,
  readPath, evaluateConditions, renderTemplate,
  runRule, dispatch,
};
