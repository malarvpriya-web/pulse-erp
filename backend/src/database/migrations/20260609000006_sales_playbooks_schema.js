export async function up(knex) {
  // Drop old schema-less table (no company_id, no steps, no data)
  await knex.raw(`DROP TABLE IF EXISTS sales_playbooks CASCADE`);

  // Rebuild with full enterprise schema
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_playbooks (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL REFERENCES companies(id),
      name             VARCHAR(255) NOT NULL,
      description      TEXT,
      category         VARCHAR(100),
      applicable_stage VARCHAR(50),
      is_active        BOOLEAN NOT NULL DEFAULT true,
      created_by       INTEGER REFERENCES employees(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS playbook_steps (
      id           SERIAL PRIMARY KEY,
      playbook_id  INTEGER NOT NULL REFERENCES sales_playbooks(id) ON DELETE CASCADE,
      step_order   INTEGER NOT NULL,
      title        VARCHAR(255) NOT NULL,
      description  TEXT,
      step_type    VARCHAR(30) NOT NULL DEFAULT 'action',
      content      TEXT,
      is_mandatory BOOLEAN NOT NULL DEFAULT true
    )
  `);

  // Indexes
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sales_playbooks_company   ON sales_playbooks(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sales_playbooks_category  ON sales_playbooks(company_id, category)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_playbook_steps_playbook   ON playbook_steps(playbook_id, step_order)`);

  // Seed 2 default playbooks for Manifest Technologies
  await knex.raw(`
    WITH mf AS (SELECT id FROM companies WHERE name = 'Manifest Technologies' LIMIT 1),
    pb1 AS (
      INSERT INTO sales_playbooks (company_id, name, description, category, applicable_stage)
      SELECT mf.id,
             'Qualification Playbook',
             'Steps to qualify a lead using BANT framework',
             'qualification',
             'qualification'
      FROM mf
      RETURNING id
    ),
    pb2 AS (
      INSERT INTO sales_playbooks (company_id, name, description, category, applicable_stage)
      SELECT mf.id,
             'Closing Playbook',
             'Steps to close a deal in negotiation stage',
             'closing',
             'negotiation'
      FROM mf
      RETURNING id
    )
    INSERT INTO playbook_steps (playbook_id, step_order, title, step_type, is_mandatory)
    SELECT pb1.id, 1, 'Send company overview deck', 'action',       true FROM pb1 UNION ALL
    SELECT pb1.id, 2, 'Schedule discovery call',    'action',       true FROM pb1 UNION ALL
    SELECT pb1.id, 3, 'Complete BANT qualification','checklist',    true FROM pb1 UNION ALL
    SELECT pb1.id, 4, 'Identify decision-maker',    'action',       true FROM pb1 UNION ALL
    SELECT pb2.id, 1, 'Review final proposal',      'action',       true FROM pb2 UNION ALL
    SELECT pb2.id, 2, 'Send closing email',         'email_template',true FROM pb2 UNION ALL
    SELECT pb2.id, 3, 'Confirm verbal agreement',   'talk_track',   true FROM pb2 UNION ALL
    SELECT pb2.id, 4, 'Collect signed contract',    'document',     true FROM pb2
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS playbook_steps CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS sales_playbooks CASCADE`);
  // Restore minimal original table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_playbooks (
      id         SERIAL PRIMARY KEY,
      title      VARCHAR(300),
      content    TEXT,
      category   VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
