/**
 * 20260715000002_project_master_product_type.js
 *
 * Adds `projects.product_type` — the electrical product classification
 * (LV / MV / HV) surfaced as a column and filter in the Project Master grid.
 *
 * Every other Project Master column already had a backing column:
 *   - project_type   (EPC/Installation/… )   20260615000010
 *   - zone                                    20260715000001
 *   - production_stage / target / forecast    20260714000002
 *   - warranty_start_date (project_warranties)20260615000010
 * `product_type` was the only field with no source, so it is added here.
 *
 * Free VARCHAR(50) — values come from the app (like project_type /
 * production_stage), so no enum migration is ever needed.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_prodtype_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS product_type VARCHAR(50)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_projects_company_product_type
    ON projects(company_id, product_type)
    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_projects_company_product_type`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS product_type`);
}
