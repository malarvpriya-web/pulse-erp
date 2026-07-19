/**
 * 20260630000005_bom_workcenter_columns.js
 * Adds columns to bom_headers and work_centres that 20260505000001 tried to create via
 * CREATE TABLE IF NOT EXISTS (which no-ops when the tables already existed with minimal schemas).
 */
export async function up(knex) {
  const safe = (sql) => knex.raw(sql).catch(() => {});

  // bom_headers
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS product_id   INTEGER`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS product_name VARCHAR(200)`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS version      INTEGER DEFAULT 1`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS status       VARCHAR(20) DEFAULT 'draft'`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS notes        TEXT`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT NOW()`);
  await safe(`ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW()`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_bom_headers_status ON bom_headers(status)`);

  // work_centres
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS capacity_hours_per_day NUMERIC(6,2) DEFAULT 8`);
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS cost_per_hour          NUMERIC(10,2) DEFAULT 0`);
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS department             VARCHAR(100)`);
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS status                VARCHAR(20) DEFAULT 'active'`);
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS company_id            INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await safe(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ DEFAULT NOW()`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_work_centres_status ON work_centres(status)`);

  // bom_lines
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS bom_id         INTEGER REFERENCES bom_headers(id) ON DELETE CASCADE`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS component_id   INTEGER`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS component_name VARCHAR(200)`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS qty            NUMERIC(12,4) DEFAULT 1`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS unit           VARCHAR(20) DEFAULT 'pcs'`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS unit_cost      NUMERIC(12,2) DEFAULT 0`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS level          INTEGER DEFAULT 1`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS parent_line_id INTEGER`);
  await safe(`ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ DEFAULT NOW()`);
}

export async function down(knex) {
  // Intentionally minimal — don't drop columns that may have data
}
