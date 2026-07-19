/**
 * Bootstrap tables that were only defined in seeds/initDb.js but were
 * never added to the formal migration chain.
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  /* ── 1. project_milestones ───────────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS project_milestones (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title             VARCHAR(300),
      due_date          DATE,
      status            VARCHAR(20) DEFAULT 'pending',
      description       TEXT,
      billing_milestone BOOLEAN NOT NULL DEFAULT FALSE,
      amount            NUMERIC(15,2) DEFAULT 0,
      owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      completed_date    DATE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Idempotent additions for DBs where the table already exists without these columns
  await raw(`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS billing_milestone BOOLEAN NOT NULL DEFAULT FALSE`);
  await raw(`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS amount            NUMERIC(15,2) DEFAULT 0`);
  await raw(`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await raw(`ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS completed_date    DATE`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id)`);

  /* ── 2. hr_downloads ─────────────────────────────────────────────────────── */
  await raw(`
    CREATE TABLE IF NOT EXISTS hr_downloads (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER,
      title          VARCHAR(300) NOT NULL,
      category       VARCHAR(100),
      description    TEXT DEFAULT '',
      file_url       TEXT,
      file_type      VARCHAR(20),
      visible_to     VARCHAR(50) NOT NULL DEFAULT 'all',
      created_by     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Idempotent additions for DBs where the table already exists
  await raw(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS company_id     INTEGER`);
  await raw(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS description    TEXT DEFAULT ''`);
  await raw(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS download_count INTEGER NOT NULL DEFAULT 0`);
  await raw(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS visible_to     VARCHAR(50) NOT NULL DEFAULT 'all'`);
  await raw(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS file_type      VARCHAR(20)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_hr_downloads_company ON hr_downloads(company_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS project_milestones CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS hr_downloads CASCADE`);
}
