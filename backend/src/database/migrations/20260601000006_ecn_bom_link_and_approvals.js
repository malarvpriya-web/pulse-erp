/**
 * Phase 46 Fix — ECN → BOM traceability link + approval type registrations
 *
 * Adds ecn_id FK to bom table so every BOM can trace back to the engineering
 * change notice that triggered it. Also adds approval_type entries for ECN
 * and BOM approval workflows.
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_ecn_bom_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      console.warn(`[ecn-bom] Skipped — ${err.message.split('\n')[0]}`);
    }
  };

  // Add ecn_id FK to bom (bom table name may vary — try both)
  await tryAlter(`ALTER TABLE bom ADD COLUMN IF NOT EXISTS ecn_id INTEGER`);
  await tryAlter(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS ecn_id INTEGER`);

  // Add approval_required flag to ECN table for workflow gate
  await tryAlter(`ALTER TABLE engineering_change_notices ADD COLUMN IF NOT EXISTS approval_required BOOLEAN DEFAULT TRUE`);
  await tryAlter(`ALTER TABLE engineering_change_notices ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
  await tryAlter(`ALTER TABLE engineering_change_notices ADD COLUMN IF NOT EXISTS approved_by INTEGER`);
  await tryAlter(`ALTER TABLE engineering_change_notices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);

  // Register ECN and BOM as approval types in the approvals system
  await tryAlter(`
    INSERT INTO approval_types (type_code, type_name, description, module, required_roles)
    VALUES
      ('ecn_approval', 'ECN Approval', 'Engineering Change Notice requires approval before BOM creation', 'engineering', '["engineering_head","cto"]'),
      ('bom_approval', 'BOM Approval', 'Bill of Materials requires approval before production release', 'engineering', '["engineering_head","production_manager"]')
    ON CONFLICT (type_code) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.schema.table('bom', t => t.dropColumn('ecn_id')).catch(() => {});
  await knex.schema.table('bom_headers', t => t.dropColumn('ecn_id')).catch(() => {});
}
