/**
 * 20261118000004 — before / after self-review on trainings (owner, 2026-11-18:
 * "reviewing themselves after the training … before and after comparison").
 *
 *   training_programs.self_review_enabled   on by default
 *   training_programs.self_review_items     the statements each person rates
 *                                           themselves on, 1–5 (JSON array of
 *                                           strings; blank = the standard two)
 *   training_self_reviews                   one row per enrolment per phase
 *                                           ('pre' before the training, 'post'
 *                                           after it): overall knowledge,
 *                                           confidence, per-statement ratings
 *                                           and a comment. The pair is what the
 *                                           before / after comparison reads.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE training_programs
      ADD COLUMN IF NOT EXISTS self_review_enabled BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS self_review_items JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_self_reviews (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER REFERENCES companies(id),
      enrollment_id  INTEGER NOT NULL REFERENCES training_enrollments(id) ON DELETE CASCADE,
      program_id     INTEGER NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
      employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      phase          VARCHAR(4) NOT NULL CHECK (phase IN ('pre', 'post')),
      knowledge      SMALLINT NOT NULL CHECK (knowledge BETWEEN 1 AND 5),
      confidence     SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
      item_ratings   JSONB NOT NULL DEFAULT '{}'::jsonb,
      comments       TEXT,
      submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (enrollment_id, phase)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS training_self_reviews_program_idx ON training_self_reviews (program_id, phase)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS training_self_reviews_employee_idx ON training_self_reviews (employee_id)`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON training_self_reviews TO pulse_app;
        GRANT USAGE, SELECT ON SEQUENCE training_self_reviews_id_seq TO pulse_app;
      END IF;
    END $$`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS training_self_reviews`);
  await knex.raw(`ALTER TABLE training_programs DROP COLUMN IF EXISTS self_review_enabled, DROP COLUMN IF EXISTS self_review_items`);
}
