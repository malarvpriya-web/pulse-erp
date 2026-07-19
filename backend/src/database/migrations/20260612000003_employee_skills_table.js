/**
 * Employee skills — proper multi-skill table replacing the single skill_type VARCHAR.
 * Creates: employee_skills, master_skill_categories
 * Seeds default skill categories for Manifest Technologies (Power Electronics / Manufacturing).
 */
export async function up(knex) {
  const safe = async (label, sql) => {
    await knex.raw('SAVEPOINT emp_skills_sp');
    try {
      await knex.raw(sql);
      await knex.raw('RELEASE SAVEPOINT emp_skills_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT emp_skills_sp');
      console.warn(`[employee_skills] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // Skill categories master
  await safe('master_skill_categories', `
    CREATE TABLE IF NOT EXISTS master_skill_categories (
      id          SERIAL        PRIMARY KEY,
      company_id  INTEGER       REFERENCES companies(id) ON DELETE CASCADE,
      name        VARCHAR(100)  NOT NULL,
      description TEXT,
      is_active   BOOLEAN       NOT NULL DEFAULT true,
      sort_order  INTEGER       NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, name)
    )
  `);

  // Per-employee skills table
  await safe('employee_skills', `
    CREATE TABLE IF NOT EXISTS employee_skills (
      id                 SERIAL        PRIMARY KEY,
      company_id         INTEGER       REFERENCES companies(id) ON DELETE CASCADE,
      employee_id        INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      skill_name         VARCHAR(150)  NOT NULL,
      category           VARCHAR(100),
      proficiency_level  VARCHAR(20)   NOT NULL DEFAULT 'beginner'
                           CHECK (proficiency_level IN ('beginner','intermediate','advanced','expert')),
      years_experience   NUMERIC(4,1),
      is_certified       BOOLEAN       NOT NULL DEFAULT false,
      certified_by       VARCHAR(200),
      certification_date DATE,
      expiry_date        DATE,
      notes              TEXT,
      created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await safe('idx employee_skills employee_id', `CREATE INDEX IF NOT EXISTS idx_emp_skills_employee ON employee_skills(employee_id)`);
  await safe('idx employee_skills company_id',  `CREATE INDEX IF NOT EXISTS idx_emp_skills_company  ON employee_skills(company_id)`);
  await safe('idx employee_skills expiry',      `CREATE INDEX IF NOT EXISTS idx_emp_skills_expiry   ON employee_skills(expiry_date) WHERE expiry_date IS NOT NULL`);
  await safe('idx employee_skills certified',   `CREATE INDEX IF NOT EXISTS idx_emp_skills_certified ON employee_skills(is_certified) WHERE is_certified = true`);

  // Seed default categories (NULL company_id = global defaults)
  await safe('seed skill categories', `
    INSERT INTO master_skill_categories (company_id, name, sort_order) VALUES
      (NULL, 'Power Electronics',        10),
      (NULL, 'HVDC Systems',             20),
      (NULL, 'STATCOM / FACTS',          30),
      (NULL, 'Solid State Transformers', 40),
      (NULL, 'Field Commissioning',      50),
      (NULL, 'Manufacturing / Assembly', 60),
      (NULL, 'Quality & Testing',        70),
      (NULL, 'R&D / Design',             80),
      (NULL, 'Project Management',       90),
      (NULL, 'Software / SCADA',        100),
      (NULL, 'HSE / Safety',            110),
      (NULL, 'Finance & Accounts',      120),
      (NULL, 'HR & Administration',     130),
      (NULL, 'Sales & Business Dev',    140),
      (NULL, 'Other',                   999)
    ON CONFLICT (company_id, name) DO NOTHING
  `);

  // Migrate existing skill_type values into the new table
  await safe('migrate skill_type', `
    INSERT INTO employee_skills (company_id, employee_id, skill_name, category, proficiency_level)
    SELECT company_id, id, skill_type, skill_type, 'intermediate'
    FROM employees
    WHERE skill_type IS NOT NULL AND skill_type != ''
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS employee_skills CASCADE`).catch(() => {});
  await knex.raw(`DROP TABLE IF EXISTS master_skill_categories CASCADE`).catch(() => {});
}
