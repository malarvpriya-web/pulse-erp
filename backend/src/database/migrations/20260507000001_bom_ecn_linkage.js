export async function up(knex) {
  await knex.raw(`
    ALTER TABLE bom_headers
      ADD COLUMN IF NOT EXISTS ecn_id           INTEGER REFERENCES engineering_changes(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS frozen_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS frozen_by_name   VARCHAR(150),
      ADD COLUMN IF NOT EXISTS change_reason    TEXT
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_headers_ecn ON bom_headers(ecn_id)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bom_headers_ecn`);
  await knex.raw(`
    ALTER TABLE bom_headers
      DROP COLUMN IF EXISTS ecn_id,
      DROP COLUMN IF EXISTS frozen_at,
      DROP COLUMN IF EXISTS frozen_by_name,
      DROP COLUMN IF EXISTS change_reason
  `);
}
