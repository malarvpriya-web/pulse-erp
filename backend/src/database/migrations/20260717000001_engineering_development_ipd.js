/**
 * 20260717000001_engineering_development_ipd.js
 *
 * Creates the Engineering Development (IPD) master — the table the
 * /engineering/development endpoint has been claiming to read since it was
 * written.
 *
 * WHY A NEW TABLE, not a repoint to eng_rd_projects:
 *   engineering.routes.js selected `project_code, project_name, project_type,
 *   phase, target_completion` FROM `rd_projects`. That relation has never
 *   existed in any migration (verified: to_regclass('public.rd_projects') IS
 *   NULL), so the route threw 42P01 on every call and the grid only ever
 *   rendered its error state. eng_rd_projects is NOT a drop-in replacement —
 *   it names those columns code/name/category/target_date and has no `phase`
 *   at all. It is also a different thing: generic R&D projects (concept ->
 *   prototype -> approved), not per-product development records that flow into
 *   production.
 *
 * TAXONOMIES (dev_type, assembly_type, status) are deliberately NOT DB CHECK
 * constraints, mirroring the reasoning in shared/projectTypes.js: PROJECT_TYPES
 * already widened 7 -> 10 once, and a CHECK makes every future addition a
 * migration. They are validated in the route layer against
 * shared/engineeringDevelopment.js instead.
 *
 * Category is LV/MV/HV (VOLTAGE_CLASSES), NOT the "LT/HT" the reference
 * checklist assumed — LT/HT appears nowhere in this codebase. It denormalises
 * product_lines.voltage_class so a record can stand alone before a product line
 * is chosen.
 *
 * company_id is NOT NULL DEFAULT 1 on purpose. Nullable company_id is the
 * documented scoping bug in this codebase (NULL rows are invisible to scoped
 * users and read as 0 in KPIs); the sibling engineering tables are nullable and
 * needed a backfill migration to recover. This table starts correct.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_ipd_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[engineering_development_ipd] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── 1. IPD numbering ────────────────────────────────────────────────────────
  // Fresh sequence — no IPD-prefixed number has ever been issued, so there is no
  // existing max to seed from. Format IPD-00001, matching seq_ips/IPS-00001.
  await safe('seq_ipd', `CREATE SEQUENCE IF NOT EXISTS seq_ipd START WITH 1 INCREMENT BY 1 NO CYCLE`);

  // ── 2. the master ───────────────────────────────────────────────────────────
  await safe('create_eng_development', `
    CREATE TABLE IF NOT EXISTS eng_development (
      id                SERIAL PRIMARY KEY,
      ipd_number        VARCHAR(20) UNIQUE,
      title             VARCHAR(255) NOT NULL,
      description       TEXT,

      -- Product Type: the Manifest catalogue ("ASTRA - 415V"). Master is
      -- product_lines, owned by projects; IPD inherits the display_name.
      product_line_id   INTEGER REFERENCES product_lines(id) ON DELETE SET NULL,

      -- Free-ish dimensions, validated in the route layer (see header note).
      dev_type          VARCHAR(40),
      assembly_type     VARCHAR(20),
      category          VARCHAR(10),
      status            VARCHAR(30) NOT NULL DEFAULT 'design',
      priority          VARCHAR(20) DEFAULT 'medium',
      owner_name        VARCHAR(120),

      started_date      DATE,
      target_close_date DATE,
      actual_close_date DATE,

      -- IPD -> IPP. Nullable: a development record exists long before (and may
      -- never reach) production. ON DELETE SET NULL keeps the IPD history when
      -- a project is removed.
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,

      company_id        INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id) ON DELETE SET NULL,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ
    )
  `);

  // ── 3. indexes for the grid's filters + sorts ───────────────────────────────
  await safe('idx_company',  `CREATE INDEX IF NOT EXISTS idx_eng_development_company  ON eng_development(company_id)`);
  await safe('idx_status',   `CREATE INDEX IF NOT EXISTS idx_eng_development_status   ON eng_development(status)`);
  await safe('idx_devtype',  `CREATE INDEX IF NOT EXISTS idx_eng_development_dev_type ON eng_development(dev_type)`);
  await safe('idx_project',  `CREATE INDEX IF NOT EXISTS idx_eng_development_project  ON eng_development(project_id)`);
  await safe('idx_prodline', `CREATE INDEX IF NOT EXISTS idx_eng_development_pline    ON eng_development(product_line_id)`);
  await safe('idx_created',  `CREATE INDEX IF NOT EXISTS idx_eng_development_created  ON eng_development(created_at DESC)`);

  console.log('[migration 20260717000001] engineering_development_ipd applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP TABLE IF EXISTS eng_development`);
  await safe(`DROP SEQUENCE IF EXISTS seq_ipd`);
}
