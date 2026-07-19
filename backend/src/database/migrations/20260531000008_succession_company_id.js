/**
 * Succession Planning — company_id multi-tenant scoping
 *
 * Adds company_id to the three succession tables so data is isolated
 * per tenant. All columns are nullable — existing single-tenant rows
 * are left as NULL; route handlers already skip the WHERE clause when
 * req.scope?.company_id is absent (backward-compatible).
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_succ_cid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (err.message?.includes('does not exist')) {
        console.warn(`[succession_cid] Skipped — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  await tryAlter('ALTER TABLE talent_assessments ADD COLUMN IF NOT EXISTS company_id INTEGER');
  await tryAlter('ALTER TABLE critical_roles     ADD COLUMN IF NOT EXISTS company_id INTEGER');
  await tryAlter('ALTER TABLE succession_plans   ADD COLUMN IF NOT EXISTS company_id INTEGER');

  await tryAlter('CREATE INDEX IF NOT EXISTS idx_talent_assessments_company ON talent_assessments(company_id)');
  await tryAlter('CREATE INDEX IF NOT EXISTS idx_critical_roles_company     ON critical_roles(company_id, risk_level)');
  await tryAlter('CREATE INDEX IF NOT EXISTS idx_succession_plans_company   ON succession_plans(company_id, critical_role_id)');
}

export async function down() {
  // Columns are intentionally not dropped — dropping destroys tenant data.
}
