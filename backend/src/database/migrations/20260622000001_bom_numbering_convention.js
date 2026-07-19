/**
 * 20260622000001_bom_numbering_convention.js
 *
 * Adds bom_number to bom_headers so the configured BOM numbering convention
 * (stored in company_settings.module='bom_policies') is persisted per BOM.
 *
 * Also adds company_id to bom_headers if somehow still missing (earlier
 * migrations may have added it via 20260618000004 — SAVEPOINT guards this).
 */
export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_bom_num_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = (err.message || '').split('\n')[0];
      if (!/already exists|does not exist|duplicate column|duplicate key/i.test(msg)) throw err;
      console.warn(`[bom_numbering_convention] skip (${label}): ${msg}`);
    }
  };

  await safe('bom_headers company_id',
    `ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  await safe('bom_headers bom_number',
    `ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS bom_number VARCHAR(80)`);

  await safe('idx_bom_headers_bom_number',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bom_headers_bom_number
     ON bom_headers(company_id, bom_number)
     WHERE bom_number IS NOT NULL`);

  console.log('[migration 20260622000001] bom_number column added to bom_headers.');
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bom_headers_bom_number`);
  await knex.raw(`ALTER TABLE bom_headers DROP COLUMN IF EXISTS bom_number`);
}
