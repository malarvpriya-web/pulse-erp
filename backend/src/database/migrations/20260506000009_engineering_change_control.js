export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS engineering_changes (
      id                 SERIAL PRIMARY KEY,
      ecn_number         VARCHAR(40) UNIQUE NOT NULL,
      title              VARCHAR(300) NOT NULL,
      change_type        VARCHAR(40) NOT NULL DEFAULT 'ECN',
      status             VARCHAR(30) NOT NULL DEFAULT 'draft',
      severity           VARCHAR(20) NOT NULL DEFAULT 'medium',
      reason             TEXT,
      impact_summary     TEXT,
      requested_by       INTEGER,
      requested_by_name  VARCHAR(150),
      owner_id           INTEGER,
      owner_name         VARCHAR(150),
      effective_from     DATE,
      approved_at        TIMESTAMPTZ,
      approved_by        INTEGER,
      approved_by_name   VARCHAR(150),
      implementation_due DATE,
      implemented_at     TIMESTAMPTZ,
      implemented_by     INTEGER,
      implemented_by_name VARCHAR(150),
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_engineering_changes_type
        CHECK (change_type IN ('ECR','ECO','ECN')),
      CONSTRAINT chk_engineering_changes_status
        CHECK (status IN ('draft','submitted','approved','rejected','implemented','cancelled')),
      CONSTRAINT chk_engineering_changes_severity
        CHECK (severity IN ('low','medium','high','critical'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS engineering_change_items (
      id                   SERIAL PRIMARY KEY,
      engineering_change_id INTEGER NOT NULL REFERENCES engineering_changes(id) ON DELETE CASCADE,
      item_type            VARCHAR(40) NOT NULL,
      item_ref_id          INTEGER,
      item_code            VARCHAR(80),
      item_name            VARCHAR(250),
      current_revision     VARCHAR(60),
      proposed_revision    VARCHAR(60),
      effectivity_note     TEXT,
      change_summary       TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_engineering_change_items_type
        CHECK (item_type IN ('bom_header','bom_line','routing_step','drawing','spec','project_order','test_plan','other'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS engineering_change_approvals (
      id                    SERIAL PRIMARY KEY,
      engineering_change_id INTEGER NOT NULL REFERENCES engineering_changes(id) ON DELETE CASCADE,
      approver_id           INTEGER NOT NULL,
      approver_name         VARCHAR(150),
      role_name             VARCHAR(80),
      status                VARCHAR(20) NOT NULL DEFAULT 'pending',
      remarks               TEXT,
      acted_at              TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_engineering_change_approvals_status
        CHECK (status IN ('pending','approved','rejected'))
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS engineering_change_events (
      id                    SERIAL PRIMARY KEY,
      engineering_change_id INTEGER NOT NULL REFERENCES engineering_changes(id) ON DELETE CASCADE,
      event_name            VARCHAR(80) NOT NULL,
      event_note            TEXT,
      actor_id              INTEGER,
      actor_name            VARCHAR(150),
      event_data            JSONB DEFAULT '{}',
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_engineering_changes_status ON engineering_changes(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_engineering_changes_type ON engineering_changes(change_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_engineering_change_items_change ON engineering_change_items(engineering_change_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_engineering_change_approvals_change ON engineering_change_approvals(engineering_change_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_engineering_change_events_change ON engineering_change_events(engineering_change_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS engineering_change_events CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS engineering_change_approvals CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS engineering_change_items CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS engineering_changes CASCADE`);
}
