/**
 * 20260630000006_vendors_name_alias.js
 * The vendors table uses `vendor_name` but many query files reference `v.name`.
 * Add `name` as a generated column (always = vendor_name) so both work.
 */
export async function up(knex) {
  // Check if name column already exists before adding
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='vendors' AND column_name='name'
      ) THEN
        ALTER TABLE vendors ADD COLUMN name TEXT GENERATED ALWAYS AS (vendor_name) STORED;
      END IF;
    END $$;
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(name)`).catch(() => {});
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE vendors DROP COLUMN IF EXISTS name`).catch(() => {});
}
