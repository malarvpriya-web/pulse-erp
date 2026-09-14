/**
 * module_settings — the generic per-module settings store two modules already
 * assume exists.
 *
 * Projects has a settings screen (`GET`/`PUT /projects/settings`) that reads and
 * writes `module_settings`, and Production reads an `allow_partial_issue` flag
 * from it before allowing a short material issue. The table has never existed,
 * so:
 *   • saving Project settings threw 42P01 and returned a bare 500;
 *   • reading them returned 500, so the screen could never load;
 *   • Production's read was wrapped in `.catch(() => ({ rows: [null] }))`, which
 *     silently resolved `allowPartial` to false — the safe direction by luck,
 *     not by design.
 *
 * The two callers disagreed on column names (`module`/`settings` in Production,
 * `module_name`/`settings_data` in Projects). `module_name`/`settings_data` is
 * adopted as canonical — it is the pair the write path uses, and the ON CONFLICT
 * in that write requires a unique key on (module_name, company_id), which is
 * created here. Production's read is corrected to match rather than the table
 * carrying both spellings.
 *
 * NOT a per-module settings table per module: several already exist
 * (`crm_settings`, `quality_settings`, `sales_settings`, …). This one is for
 * modules that never got a dedicated table, and it must not be used to
 * duplicate settings that already live in one of those.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS module_settings (
      id            SERIAL PRIMARY KEY,
      module_name   VARCHAR(60) NOT NULL,
      settings_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // The write path uses ON CONFLICT (module_name, company_id), so this index is
  // required for it to work at all. NULLS NOT DISTINCT so a global (company-less)
  // row also upserts rather than duplicating.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS module_settings_module_company_unique
      ON module_settings (module_name, company_id) NULLS NOT DISTINCT;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS module_settings;`);
}
