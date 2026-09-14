/**
 * rm_issues / rm_issue_items — raw-material issue to department.
 *
 * The RM Issue feature is fully built and reachable: `rmIssue.service.js` and
 * `rmIssue.repository.js` back four mounted endpoints under `/inventory`
 * (create issue, list issues, get issue, consumption trends). Neither table has
 * ever existed, so every one of those endpoints threw 42P01 at runtime.
 *
 * A materialised view in migration 20260522000001 (`v_material_consumption_by_
 * project`) also joins them, which is why that view is missing too — it could
 * never have been created.
 *
 * The schema is taken directly from the repository's own INSERT/SELECT
 * statements rather than invented, so the existing code works unchanged:
 *   rm_issues       (issue_number, department_id, issued_by, issue_date,
 *                    warehouse_id, purpose, notes, deleted_at)
 *   rm_issue_items  (issue_id, item_id, quantity, rate, remarks, created_at)
 *
 * `material_issue_logs` is deliberately NOT reused: it records issue against a
 * PRODUCTION ORDER, not against a department, and has no warehouse or issue
 * document. They are different business events.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rm_issues (
      id             SERIAL PRIMARY KEY,
      issue_number   VARCHAR(50),
      department_id  INTEGER,
      issued_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      issue_date     DATE NOT NULL DEFAULT CURRENT_DATE,
      warehouse_id   INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      purpose        TEXT,
      notes          TEXT,
      company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    );
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rm_issue_items (
      id          SERIAL PRIMARY KEY,
      issue_id    INTEGER NOT NULL REFERENCES rm_issues(id) ON DELETE CASCADE,
      item_id     INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      quantity    NUMERIC(18,4) NOT NULL DEFAULT 0,
      rate        NUMERIC(18,4) NOT NULL DEFAULT 0,
      remarks     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS rm_issues_number_unique ON rm_issues (company_id, issue_number) WHERE issue_number IS NOT NULL AND deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rm_issues_date       ON rm_issues (issue_date) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rm_issues_department ON rm_issues (department_id) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rm_issue_items_issue ON rm_issue_items (issue_id);`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rm_issue_items_item  ON rm_issue_items (item_id);`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS rm_issue_items;`);
  await knex.raw(`DROP TABLE IF EXISTS rm_issues;`);
}
