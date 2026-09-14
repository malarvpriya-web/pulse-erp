/**
 * Final columns + the materialised view that could never be created.
 *
 * Closing out the repo-wide SQL-reference burndown.
 *
 *  • `bom_headers.project_id / sales_order_id / created_by` — the Order History
 *    panel traces a project's BOMs through these; none existed.
 *  • `inventory_batches.production_order_id` — batch genealogy back to the order
 *    that consumed it.
 *  • `cost_centers.department / department_id` — the project cost engine groups
 *    spend by department.
 *  • `bank_accounts.branch / opening_balance / chart_account_id` — the bank
 *    account screen writes all three; `chart_account_id` is what ties a bank
 *    account to its GL account, so without it bank entries could not be posted.
 *  • `invoices.hsn_sac / gst_rate / reverse_charge` — statutory GST fields the
 *    GST return builder reads. Their absence is why those returns were empty.
 *  • `rm_issues.project_id` — raw material issued against a project, which the
 *    project cost roll-up sums.
 *
 * `v_material_consumption_by_project` is a view declared back in migration
 * 20260522000001 that has never existed, because it joins `rm_issues` /
 * `rm_issue_items` — tables that were themselves never created until
 * 20260819000007. With those in place and project_id added, it can finally be
 * built, which is what `advancedInventory.repository.js` reads.
 */

const ADDITIONS = [
  ['bom_headers',       'project_id',          'integer REFERENCES projects(id) ON DELETE SET NULL'],
  ['bom_headers',       'sales_order_id',      'integer REFERENCES sales_orders(id) ON DELETE SET NULL'],
  ['bom_headers',       'created_by',          'integer'],
  ['inventory_batches', 'production_order_id', 'integer'],
  ['cost_centers',      'department',          'text'],
  ['cost_centers',      'department_id',       'integer'],
  ['bank_accounts',     'branch',              'text'],
  ['bank_accounts',     'opening_balance',     'numeric(18,2) DEFAULT 0'],
  ['bank_accounts',     'chart_account_id',    'integer'],
  ['invoices',          'hsn_sac',             'varchar(20)'],
  ['invoices',          'gst_rate',            'numeric(5,2)'],
  ['invoices',          'reverse_charge',      'boolean NOT NULL DEFAULT false'],
  ['rm_issues',         'project_id',          'integer REFERENCES projects(id) ON DELETE SET NULL'],
];

export async function up(knex) {
  for (const [table, column, type] of ADDITIONS) {
    const { rows } = await knex.raw(`SELECT to_regclass('public.${table}') AS t`);
    if (!rows[0]?.t) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bom_headers_project ON bom_headers (project_id) WHERE project_id IS NOT NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rm_issues_project   ON rm_issues (project_id)   WHERE project_id IS NOT NULL;`);

  // The view from 20260522000001, buildable at last.
  await knex.raw(`DROP VIEW IF EXISTS v_material_consumption_by_project;`);
  await knex.raw(`
    CREATE VIEW v_material_consumption_by_project AS
      SELECT ri.project_id,
             p.project_name,
             ii.id           AS item_id,
             ii.item_code,
             ii.item_name,
             SUM(rii.quantity)              AS total_qty,
             SUM(rii.quantity * rii.rate)   AS total_value,
             COUNT(DISTINCT ri.id)          AS issue_count,
             MAX(ri.issue_date)             AS last_issue_date
        FROM rm_issue_items rii
        JOIN rm_issues       ri ON rii.issue_id = ri.id AND ri.deleted_at IS NULL
        JOIN inventory_items ii ON rii.item_id  = ii.id
        LEFT JOIN projects   p  ON p.id = ri.project_id AND p.deleted_at IS NULL
       WHERE ri.project_id IS NOT NULL
       GROUP BY ri.project_id, p.project_name, ii.id, ii.item_code, ii.item_name;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS v_material_consumption_by_project;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_rm_issues_project;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_bom_headers_project;`);
  for (const [table, column] of [...ADDITIONS].reverse()) {
    const { rows } = await knex.raw(`SELECT to_regclass('public.${table}') AS t`);
    if (!rows[0]?.t) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column};`);
  }
}
