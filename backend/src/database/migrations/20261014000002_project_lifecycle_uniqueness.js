/**
 * 20261014000002_project_lifecycle_uniqueness.js
 *
 * Database protection for project creation and the operations lifecycle
 * (P1_PROJECT_LIFECYCLE_PLAN.md, Phase 3 / Migration A). Since Phase 2 every
 * creator goes through ensureProject() (projects/services/projectCreation.service.js),
 * which serialises on row locks. These are the backstop for a future caller
 * that does not:
 *
 *   sales_orders.project_id          nullable INTEGER, FK -> projects(id) ON DELETE SET NULL,
 *                                    partial index idx_sales_orders_project_id.
 *                                    One column = an order belongs to at most one
 *                                    project; a project may hold several orders.
 *   ux_projects_opportunity_live     UNIQUE projects(opportunity_id)
 *                                    WHERE opportunity_id IS NOT NULL AND deleted_at IS NULL
 *                                    — one LIVE project per opportunity. "Live" is the
 *                                    code's own meaning (deleted_at IS NULL); a soft-
 *                                    deleted project frees its opportunity.
 *   ux_lifecycle_open_per_project    UNIQUE lifecycle_instances(project_id)
 *                                    WHERE project_id IS NOT NULL AND status IN ('active','on_hold')
 *   ux_lifecycle_open_per_sales_order UNIQUE lifecycle_instances(sales_order_id)
 *                                    WHERE sales_order_id IS NOT NULL AND status IN ('active','on_hold')
 *                                    — compatible with one project holding several
 *                                    orders: the project's single lifecycle keeps its
 *                                    primary order, the others have no lifecycle row.
 *
 * Existing data is not changed. No row is updated, deleted or reassigned;
 * sales_orders.project_id starts NULL (it is not backfilled from the free-text
 * projects.sales_order_ref — linking legacy rows is reconciliation, Phase 5).
 * Historical orphans (lifecycles whose project no longer exists) are left as
 * they are: no FK or NOT NULL is added to lifecycle_instances.
 *
 * Preflight: before any index is built, the tables are locked against writes
 * and checked for rows the new rules would reject. If any exist the migration
 * throws with the exact record ids per constraint, the runner rolls the whole
 * migration back, and nothing is created. It never picks a winner.
 *
 * Rollback (`npm run migrate:rollback`) drops the three unique indexes, the FK
 * and the index on sales_orders.project_id, but KEEPS the column and its data,
 * so links written while this was live are not lost. Re-applying is safe: the
 * column is reused, and links that point at a project which no longer exists
 * are reported (the FK cannot be re-added over them) instead of being cleared.
 * The previous application code ignores the column, so the old code runs on
 * either state.
 */

const LIVE_OPPORTUNITY_INDEX = 'ux_projects_opportunity_live';
const OPEN_PER_PROJECT_INDEX = 'ux_lifecycle_open_per_project';
const OPEN_PER_ORDER_INDEX = 'ux_lifecycle_open_per_sales_order';
const ORDER_PROJECT_INDEX = 'idx_sales_orders_project_id';
const ORDER_PROJECT_FK = 'fk_sales_orders_project';

/**
 * Rows the new rules would reject, per constraint. Read-only.
 * @returns {Promise<Array<{ constraint: string, rule: string, conflicts: object[] }>>} only non-empty entries
 */
export async function preflight(knex) {
  const checks = [
    {
      constraint: LIVE_OPPORTUNITY_INDEX,
      rule: 'more than one live project for the same opportunity',
      sql: `SELECT opportunity_id, array_agg(id ORDER BY id) AS project_ids
              FROM projects
             WHERE opportunity_id IS NOT NULL AND deleted_at IS NULL
             GROUP BY opportunity_id HAVING COUNT(*) > 1 ORDER BY opportunity_id`,
    },
    {
      constraint: OPEN_PER_PROJECT_INDEX,
      rule: 'more than one open (active / on_hold) lifecycle for the same project',
      sql: `SELECT project_id, array_agg(id ORDER BY id) AS lifecycle_ids
              FROM lifecycle_instances
             WHERE project_id IS NOT NULL AND status IN ('active','on_hold')
             GROUP BY project_id HAVING COUNT(*) > 1 ORDER BY project_id`,
    },
    {
      constraint: OPEN_PER_ORDER_INDEX,
      rule: 'more than one open (active / on_hold) lifecycle for the same sales order',
      sql: `SELECT sales_order_id, array_agg(id ORDER BY id) AS lifecycle_ids
              FROM lifecycle_instances
             WHERE sales_order_id IS NOT NULL AND status IN ('active','on_hold')
             GROUP BY sales_order_id HAVING COUNT(*) > 1 ORDER BY sales_order_id`,
    },
  ];
  // Only on a re-apply after a rollback (the column is kept): links whose
  // project no longer exists would block the FK.
  const { rows: col } = await knex.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_orders' AND column_name = 'project_id'`);
  if (col.length) {
    checks.push({
      constraint: ORDER_PROJECT_FK,
      rule: 'sales_orders.project_id points at a project that does not exist',
      sql: `SELECT so.id AS sales_order_id, so.project_id
              FROM sales_orders so LEFT JOIN projects p ON p.id = so.project_id
             WHERE so.project_id IS NOT NULL AND p.id IS NULL ORDER BY so.id`,
    });
  }
  const found = [];
  for (const { constraint, rule, sql } of checks) {
    const { rows } = await knex.raw(sql);
    if (rows.length) found.push({ constraint, rule, conflicts: rows });
  }
  return found;
}

export function describeConflicts(found) {
  return found.map(({ constraint, rule, conflicts }) =>
    `  ${constraint} — ${rule}:\n` + conflicts.map(r => `    ${JSON.stringify(r)}`).join('\n')).join('\n');
}

export async function up(knex) {
  // Writers wait while the data is checked and the indexes are built, so a
  // duplicate cannot slip in between the check and the index. Readers are not
  // blocked; the runner holds this transaction only for this migration.
  await knex.raw(`LOCK TABLE projects, lifecycle_instances, sales_orders IN SHARE ROW EXCLUSIVE MODE`);

  const found = await preflight(knex);
  if (found.length) {
    throw new Error(
      'Project / lifecycle uniqueness NOT applied — existing records break the new rules. '
      + 'Resolve these (no record was changed), then run the migration again:\n' + describeConflicts(found));
  }

  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS project_id INTEGER`);
  const { rows: fk } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = 'sales_orders'::regclass`, [ORDER_PROJECT_FK]);
  if (!fk.length) {
    await knex.raw(
      `ALTER TABLE sales_orders ADD CONSTRAINT ${ORDER_PROJECT_FK}
         FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL`);
  }
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${ORDER_PROJECT_INDEX} ON sales_orders (project_id) WHERE project_id IS NOT NULL`);

  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${LIVE_OPPORTUNITY_INDEX}
       ON projects (opportunity_id) WHERE opportunity_id IS NOT NULL AND deleted_at IS NULL`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_PER_PROJECT_INDEX}
       ON lifecycle_instances (project_id) WHERE project_id IS NOT NULL AND status IN ('active','on_hold')`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_PER_ORDER_INDEX}
       ON lifecycle_instances (sales_order_id) WHERE sales_order_id IS NOT NULL AND status IN ('active','on_hold')`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${OPEN_PER_ORDER_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${OPEN_PER_PROJECT_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${LIVE_OPPORTUNITY_INDEX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${ORDER_PROJECT_INDEX}`);
  await knex.raw(`ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS ${ORDER_PROJECT_FK}`);
  // sales_orders.project_id is deliberately kept: dropping it would discard the
  // order -> project links recorded while this migration was live.
}
