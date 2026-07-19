/**
 * Organization Setup — member panel data layer.
 *
 * `org_relationships` becomes the explicit membership table for the org chart:
 * one row per employee that has been *placed* in the structure. Identity fields
 * (name, department, designation, photo) are NOT copied here — they stay in the
 * employees master and are joined at read time.
 *
 * Adds:
 *   employees.sub_department          — new master field, surfaced on Org Setup
 *   org_relationships.role            — 'head' | 'member' (hierarchy position)
 *   org_relationships.display_order   — sibling ordering within a level
 *   org_relationships.is_active       — membership active flag (independent of
 *                                       employees.status, which is HR lifecycle)
 *   org_relationships.company_id      — scoping (BUG 1); integer, matches employees
 *
 * Backfills every live employee as a member so the existing reporting tree is
 * preserved. reporting_manager_id remains the hierarchy driver (it also feeds
 * approval routing in home.service.js) — role/display_order are additive.
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT org_setup_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT org_setup_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT org_setup_sp');
      console.warn(`[org_setup_members] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('employees.sub_department', `
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS sub_department VARCHAR(100)
  `);

  await safe('org_relationships.role', `
    ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS role VARCHAR(10) DEFAULT 'member'
  `);
  await safe('org_relationships.display_order', `
    ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0
  `);
  await safe('org_relationships.is_active', `
    ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
  `);
  await safe('org_relationships.company_id', `
    ALTER TABLE org_relationships ADD COLUMN IF NOT EXISTS company_id INTEGER
  `);

  await safe('role check constraint', `
    ALTER TABLE org_relationships
      ADD CONSTRAINT org_relationships_role_chk CHECK (role IN ('head', 'member'))
  `);

  // employee_id is already UNIQUE from the creating migration, but the ON CONFLICT
  // upsert path depends on it — make sure it is there before we rely on it.
  await safe('unique employee_id', `
    CREATE UNIQUE INDEX IF NOT EXISTS org_relationships_employee_id_uidx
      ON org_relationships(employee_id)
  `);

  await safe('idx company_id', `
    CREATE INDEX IF NOT EXISTS idx_org_relationships_company_id
      ON org_relationships(company_id)
  `);
  await safe('idx display_order', `
    CREATE INDEX IF NOT EXISTS idx_org_relationships_display_order
      ON org_relationships(display_order)
  `);

  // Backfill: every live employee becomes a member, preserving current reporting
  // lines. Self-referencing manager rows (seen live: employee 1 → manager 1) are
  // normalised to NULL so they cannot seed a cycle.
  await safe('backfill members from employees', `
    INSERT INTO org_relationships
      (employee_id, manager_id, department, company_id, role, display_order, is_active)
    SELECT
      e.id,
      NULLIF(e.reporting_manager_id, e.id),
      e.department,
      e.company_id,
      'member',
      0,
      TRUE
    FROM employees e
    WHERE e.deleted_at IS NULL
      AND LOWER(e.status) IN ('active', 'probation', 'notice')
    ON CONFLICT (employee_id) DO NOTHING
  `);

  // Anyone with at least one direct report is a Head; everyone else stays a Member.
  await safe('derive head role', `
    UPDATE org_relationships o
    SET role = 'head'
    WHERE EXISTS (
      SELECT 1 FROM employees d
      WHERE d.reporting_manager_id = o.employee_id
        AND d.id <> o.employee_id
        AND d.deleted_at IS NULL
    )
  `);

  // Seed a deterministic display_order per (department, role) so the chart has a
  // stable order out of the box instead of falling back to first_name.
  await safe('seed display_order', `
    UPDATE org_relationships o
    SET display_order = s.rn
    FROM (
      SELECT o2.id,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(o2.department, '')
               ORDER BY CASE WHEN o2.role = 'head' THEN 0 ELSE 1 END, e.first_name
             ) AS rn
      FROM org_relationships o2
      JOIN employees e ON e.id = o2.employee_id
    ) s
    WHERE s.id = o.id
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE org_relationships DROP CONSTRAINT IF EXISTS org_relationships_role_chk`).catch(() => {});
  await knex.raw(`ALTER TABLE org_relationships DROP COLUMN IF EXISTS role`).catch(() => {});
  await knex.raw(`ALTER TABLE org_relationships DROP COLUMN IF EXISTS display_order`).catch(() => {});
  await knex.raw(`ALTER TABLE org_relationships DROP COLUMN IF EXISTS is_active`).catch(() => {});
  await knex.raw(`ALTER TABLE org_relationships DROP COLUMN IF EXISTS company_id`).catch(() => {});
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS sub_department`).catch(() => {});
}
