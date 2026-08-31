/**
 * Assorted columns that live code writes and the schema never had.
 *
 * The tail of the repo-wide SQL-reference burndown. Each of these is a column a
 * mounted route reads or writes today, with no equivalent under another name —
 * unlike the bulk of the burndown, which was naming drift and got remapped in
 * code rather than added here.
 *
 * Grouped by why they are needed:
 *
 *  • `updated_at` on eway_bills / payroll_loans / pick_lists / review_cycles —
 *    each has an UPDATE that stamps it. Without the column those updates threw.
 *  • `maintenance_logs.notes`, `spare_parts.category` — written by the
 *    maintenance screens.
 *  • `budget_actuals.source` / `.recorded_date` — the budget-vs-actual posting
 *    records where a figure came from and when; both were dropped on the floor.
 *  • `training_programs.budget`, `training_enrollments.feedback_comments` —
 *    L&D reporting reads both.
 *  • `expense_claim_items.bill_status` / `.category_id` — claim line state.
 *  • `quality_inspections.inspection_cost` / `.production_order_id` — the
 *    project cost roll-up sums inspection cost per production order.
 *  • `amc_contracts.drive_file_id` / `.drive_link` — the Drive document link,
 *    same pair every other Drive-backed table carries.
 *  • `approvals.request_title` / `.request_type` — the probation service writes
 *    both when raising a confirmation approval.
 *  • `purchase_requests.rejection_reason` — recorded on reject.
 *  • `project_cost_summary.actual_profit` — profitability reads it.
 *  • `support_tickets.category_id` / `.sla_policy_id` — needed by the Finance
 *    ticket repository now that it points at the canonical Service Desk table.
 *  • `generated_documents.category` — the documents repository classifies by it.
 */

const ADDITIONS = [
  ['eway_bills',            'updated_at',           'timestamptz NOT NULL DEFAULT NOW()'],
  ['payroll_loans',         'updated_at',           'timestamptz NOT NULL DEFAULT NOW()'],
  ['pick_lists',            'updated_at',           'timestamptz NOT NULL DEFAULT NOW()'],
  ['review_cycles',         'updated_at',           'timestamptz NOT NULL DEFAULT NOW()'],
  ['review_cycles',         'review_period',        'text'],
  ['maintenance_logs',      'notes',                'text'],
  ['spare_parts',           'category',             'text'],
  ['budget_actuals',        'source',               'varchar(60)'],
  ['budget_actuals',        'recorded_date',        'date DEFAULT CURRENT_DATE'],
  ['training_programs',     'budget',               'numeric(18,2)'],
  ['training_enrollments',  'feedback_comments',    'text'],
  ['expense_claim_items',   'bill_status',          "varchar(30) NOT NULL DEFAULT 'pending'"],
  ['expense_claim_items',   'category_id',          'integer'],
  ['quality_inspections',   'inspection_cost',      'numeric(18,2)'],
  ['quality_inspections',   'production_order_id',  'integer'],
  ['amc_contracts',         'drive_file_id',        'text'],
  ['amc_contracts',         'drive_link',           'text'],
  ['approvals',             'request_title',        'text'],
  ['approvals',             'request_type',         'varchar(60)'],
  ['purchase_requests',     'rejection_reason',     'text'],
  ['project_cost_summary',  'actual_profit',        'numeric(18,2)'],
  ['support_tickets',       'category_id',          'integer'],
  ['support_tickets',       'sla_policy_id',        'integer'],
  ['generated_documents',   'category',             'varchar(60)'],
];

export async function up(knex) {
  for (const [table, column, type] of ADDITIONS) {
    // Skip cleanly if a table was dropped by a later schema change rather than
    // failing the whole migration on one absent relation.
    const { rows } = await knex.raw(`SELECT to_regclass('public.${table}') AS t`);
    if (!rows[0]?.t) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`);
  }

  // actual_profit is derivable from what the roll-up already stores, so seed it
  // rather than leaving every historical row NULL.
  await knex.raw(`
    UPDATE project_cost_summary
       SET actual_profit = COALESCE(revenue, 0) - COALESCE(total_cost, 0)
     WHERE actual_profit IS NULL;
  `);
}

export async function down(knex) {
  for (const [table, column] of [...ADDITIONS].reverse()) {
    const { rows } = await knex.raw(`SELECT to_regclass('public.${table}') AS t`);
    if (!rows[0]?.t) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`);
  }
}
