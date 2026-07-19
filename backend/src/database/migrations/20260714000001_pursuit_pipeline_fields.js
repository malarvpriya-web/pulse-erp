/**
 * 20260714000001_pursuit_pipeline_fields.js
 *
 * Backing columns for the unified CRM Pursuits page. The reference grid needs
 * fields the opportunities table never carried:
 *
 * 1. `opportunity_number` — human ID in IPM-XXXXXX form. A STORED generated
 *    column off the SERIAL `id` (IPM- + 6-digit zero pad). No sequence to drift
 *    (cf. the seq_* bugs), no app code, stable for the life of the row.
 *
 * 2. `estimate_value`  — the Estimate(Lac) column, the internal cost/estimate
 *    figure, kept distinct from `expected_value` (the customer-facing Value).
 *
 * 3. `held_by`         — the person currently sitting on the pursuit, distinct
 *    from `assigned_to` (the owner). Both FK to employees(id).
 *
 * 4. `follow_up_date`  — next action date shown on the row. Separate from
 *    lead_activities.next_followup_date (which is per-activity history).
 *
 * `Shelved` is a new pipeline state. `stage` is a free VARCHAR(50), so no enum
 * change is needed — the value is introduced by the app + queries only.
 *
 * Also a guarded company_id NULL->1 backfill: scoped users (superadmin resolves
 * to company 1) cannot see NULL-company rows, which would render the new page
 * empty. Same fix as 20260706000003 / 20260709000004 on other tenant tables.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_pursuit_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS estimate_value NUMERIC(15,2)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS held_by        INTEGER REFERENCES employees(id)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS follow_up_date DATE`);

  // Generated ID. Wrapped in safe() because GENERATED columns can't be added
  // with IF NOT EXISTS on older PG — a re-run hits "column already exists" and
  // is swallowed by the savepoint guard.
  await safe(`
    ALTER TABLE opportunities
      ADD COLUMN opportunity_number VARCHAR(20)
      GENERATED ALWAYS AS ('IPM-' || LPAD(id::text, 6, '0')) STORED
  `);

  // Legacy rows carry NULL company_id and are invisible to scoped queries.
  // Only touch NULLs, and only when company 1 exists.
  await safe(`
    UPDATE opportunities
       SET company_id = 1
     WHERE company_id IS NULL
       AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM companies WHERE id = 1)
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_opportunities_company_followup
    ON opportunities(company_id, follow_up_date)
    WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_opportunities_held_by
    ON opportunities(held_by)
    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_company_followup`);
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_held_by`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS opportunity_number`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS follow_up_date`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS held_by`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS estimate_value`);
}
