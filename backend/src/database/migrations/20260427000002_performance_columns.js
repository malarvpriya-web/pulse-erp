export async function up(knex) {
  // performance_goals — add priority + category
  await knex.raw(`ALTER TABLE performance_goals ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'Medium'`);
  await knex.raw(`ALTER TABLE performance_goals ADD COLUMN IF NOT EXISTS category VARCHAR(100)`);

  // performance_reviews — add all columns the repo/frontend needs
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS review_type VARCHAR(50)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS final_rating NUMERIC(3,1)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS manager_rating NUMERIC(3,1)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS self_rating NUMERIC(3,1)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS self_comments TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS manager_comments TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS achievements TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS challenges TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS learnings TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS next_goals TEXT`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS self_submitted_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS manager_submitted_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS promotion_recommendation BOOLEAN DEFAULT FALSE`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS salary_revision_percentage NUMERIC(5,2)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS kra_score NUMERIC(5,2)`);
  await knex.raw(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS behavioral_score NUMERIC(5,2)`);

  // performance_competencies table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS performance_competencies (
      id              SERIAL PRIMARY KEY,
      review_id       INTEGER REFERENCES performance_reviews(id) ON DELETE CASCADE,
      employee_id     INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      competency_name VARCHAR(100) NOT NULL,
      self_score      NUMERIC(3,1),
      manager_score   NUMERIC(3,1),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // goal_checkins table for progress tracking
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS goal_checkins (
      id          SERIAL PRIMARY KEY,
      goal_id     INTEGER REFERENCES performance_goals(id) ON DELETE CASCADE,
      achieved_value NUMERIC(12,2) NOT NULL,
      note        TEXT,
      checked_in_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS goal_checkins`);
  await knex.raw(`DROP TABLE IF EXISTS performance_competencies`);
}
