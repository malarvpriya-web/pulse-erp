export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_policies (
      id          SERIAL PRIMARY KEY,
      title       VARCHAR(200) NOT NULL,
      category    VARCHAR(50)  DEFAULT 'General',
      description TEXT         DEFAULT '',
      file_url    TEXT         DEFAULT '#',
      created_by  INTEGER,
      created_at  TIMESTAMPTZ  DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  await knex.raw(`
    ALTER TABLE hr_policies
      ADD COLUMN IF NOT EXISTS company_id INTEGER,
      ADD COLUMN IF NOT EXISTS drive_url TEXT,
      ADD COLUMN IF NOT EXISTS requires_acknowledgement BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS applicable_to VARCHAR(50) DEFAULT 'all';
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_policy_acknowledgements (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL REFERENCES hr_policies(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL,
      acknowledged_at TIMESTAMPTZ DEFAULT NOW(),
      ip_address INET,
      UNIQUE(policy_id, employee_id)
    );
  `);

  await knex.raw(`
    ALTER TABLE hr_policy_acknowledgements
      ADD COLUMN IF NOT EXISTS ip_address INET;
  `);
}

export async function down() {}
