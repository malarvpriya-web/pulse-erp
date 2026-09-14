/**
 * 20260904000002_validation_rules_crm_sales_service.js
 *
 * Seeds validation rules for the modules that had none.
 *
 * WHY
 * ---
 * `validation_rules` held five rows covering `leaves` and `projects`. Every
 * other module calling `validate()` — finance, inventory, service — found no
 * rules and returned `{ valid: true }` for any input. That is how a ticket
 * posted with no `title` passed validation, reached Postgres, and came back as a
 * raw 500 quoting `support_tickets_title_not_null`.
 *
 * A CORRECTION TO §153
 * --------------------
 * The audit reported the engine as "switched off". It is not. `featureFlags.js`
 * is opt-OUT — `isEnabled()` returns true unless the value is the exact string
 * "false" — so `VALIDATION_ENGINE_ENABLED` being absent from .env means ENABLED.
 * Verified by importing the module: all four engine flags read `true`. The
 * engine has been running the whole time against an almost-empty rule table.
 *
 * WHY THIS MIGRATION COULD NOT COME FIRST
 * ---------------------------------------
 * Before the engine change that ships alongside it, every rule was implicitly
 * `required` on every call: `evalRule` fired `min`/`min_length` on absent values
 * (`isNaN(undefined) || …` is true), and `validate()` made no distinction
 * between a create and an update. The live consequence, reproduced before the
 * fix:
 *
 *   PUT /api/projects/projects/1697  {"status":"active"}
 *   → 422  project_name is required · budget must be a positive number
 *
 * Seeding rules for four more modules on top of that would have broken every
 * partial update across CRM, Sales and Service. The engine now (a) fires only
 * `required` on an absent value and (b) accepts `{ partial: true }`, which the
 * PUT/PATCH call sites now pass.
 *
 * SCOPE OF THE RULES BELOW
 * ------------------------
 * Deliberately conservative: fields that are NOT NULL in the schema or that
 * carry a CHECK constraint, so a rule failing here would otherwise have been a
 * 500 from Postgres. Business policy (minimum deal size, mandatory next step)
 * is left to whoever owns the process — a migration should not invent policy.
 *
 * company_id is NULL on every row, meaning "applies to every tenant". The
 * engine's new tenant filter reads `company_id = $2 OR company_id IS NULL`.
 */

const RULES = [
  // ── service: support_tickets.title is NOT NULL ────────────────────────────
  { module: 'service', field: 'title', code: 'service_title_required', name: 'Ticket Title Required',
    expr: { required: true, min_length: 3 },
    msg: 'A ticket needs a title of at least 3 characters' },
  { module: 'service', field: 'priority', code: 'service_priority_valid', name: 'Ticket Priority Valid',
    expr: { pattern: '^(low|medium|high|critical|urgent)$' },
    msg: 'Priority must be low, medium, high, critical or urgent' },

  // ── crm ───────────────────────────────────────────────────────────────────
  { module: 'crm', field: 'company_name', code: 'crm_company_required', name: 'Lead Company Required',
    expr: { required: true, min_length: 2 },
    msg: 'Company name is required' },
  { module: 'crm', field: 'email', code: 'crm_email_format', name: 'Lead Email Format',
    // Applies only when an email is supplied — leads are frequently phone-only.
    expr: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$' },
    msg: 'Email address is not a valid format' },
  { module: 'crm', field: 'estimated_value', code: 'crm_value_non_negative', name: 'Lead Value Non-Negative',
    expr: { min: 0 },
    msg: 'Estimated value cannot be negative' },
  { module: 'crm', field: 'probability', code: 'crm_probability_range', name: 'Lead Probability Range',
    expr: { min: 0, max: 100 },
    msg: 'Probability must be between 0 and 100' },

  // ── sales ─────────────────────────────────────────────────────────────────
  { module: 'sales', field: 'opportunity_name', code: 'sales_opp_name_required', name: 'Opportunity Name Required',
    expr: { required: true, min_length: 2 },
    msg: 'Opportunity name is required' },
  { module: 'sales', field: 'expected_value', code: 'sales_expected_value_non_negative', name: 'Expected Value Non-Negative',
    expr: { min: 0 },
    msg: 'Expected value cannot be negative' },
  { module: 'sales', field: 'probability_percentage', code: 'sales_probability_range', name: 'Opportunity Probability Range',
    expr: { min: 0, max: 100 },
    msg: 'Probability must be between 0 and 100' },
  { module: 'sales', field: 'discount_pct', code: 'sales_discount_range', name: 'Discount Percentage Range',
    expr: { min: 0, max: 100 },
    msg: 'Discount must be between 0 and 100 percent' },

  // ── marketing ─────────────────────────────────────────────────────────────
  { module: 'marketing', field: 'name', code: 'marketing_campaign_name_required', name: 'Campaign Name Required',
    expr: { required: true, min_length: 2 },
    msg: 'Campaign name is required' },
  { module: 'marketing', field: 'budget', code: 'marketing_budget_non_negative', name: 'Campaign Budget Non-Negative',
    expr: { min: 0 },
    msg: 'Campaign budget cannot be negative' },
];

export async function up(knex) {
  const values = [];
  const params = [];
  for (const r of RULES) {
    const i = params.length;
    values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},true,NULL)`);
    params.push(r.name, r.code, r.module, r.field,
                r.expr.required ? 'required' : (r.expr.pattern ? 'pattern' : 'range'),
                JSON.stringify(r.expr), r.msg);
  }
  await knex.raw(
    `INSERT INTO validation_rules
       (name, code, module, field_name, rule_type, rule_expr, error_message, is_active, company_id)
     VALUES ${values.join(',')}
     ON CONFLICT (code) DO NOTHING`,
    params
  );
  const { rows } = await knex.raw(
    `SELECT module, COUNT(*)::int AS n FROM validation_rules WHERE is_active = true GROUP BY module ORDER BY module`
  );
  console.log('[validation_rules] active rules per module: ' +
    rows.map(r => `${r.module}=${r.n}`).join(' '));
}

export async function down(knex) {
  const codes = RULES.map(r => r.code);
  await knex.raw(`DELETE FROM validation_rules WHERE code = ANY($1)`, [codes]);
}
