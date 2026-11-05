/**
 * Education columns, and the résumé's own text.
 *
 * Two of the audit's blocking schema gaps, closed together because the résumé
 * parser fills both.
 *
 * ── EDUCATION ───────────────────────────────────────────────────────────────
 * `candidates` had no qualification or specialisation column of any kind, so
 * "find me BE Electrical candidates" — the brief's own worked example — could
 * not be asked at all. Adding them to `candidates` rather than creating a
 * separate `candidate_education` table is a deliberate narrowing: recruiters
 * filter on the HIGHEST relevant qualification, not on a full academic history,
 * and one row per candidate keeps the search a plain WHERE instead of an
 * EXISTS over a child table. A full history table can come later if a customer
 * needs to record every degree; nothing here forecloses it.
 *
 * ── RESUME TEXT ─────────────────────────────────────────────────────────────
 * `resume_text` holds the extracted plain text, with a GIN full-text index, so
 * "search by résumé content" becomes possible. It is populated only when a
 * résumé is actually parsed; a candidate typed in by hand simply has none, and
 * the search degrades to not matching them rather than to an error.
 *
 * `parsed_at` / `parse_source` record that a machine touched the record and
 * which file it read, so a recruiter can tell an extracted value from a typed
 * one when something looks wrong.
 */

const QUALIFICATIONS = `'Diploma','BE/BTech','ME/MTech','MBA','MCA','BCA','BSc','MSc','BCom','PhD','Other'`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE candidates
      ADD COLUMN IF NOT EXISTS qualification    VARCHAR(30),
      ADD COLUMN IF NOT EXISTS specialisation   VARCHAR(120),
      ADD COLUMN IF NOT EXISTS institution      VARCHAR(200),
      ADD COLUMN IF NOT EXISTS graduation_year  INTEGER,
      ADD COLUMN IF NOT EXISTS resume_text      TEXT,
      ADD COLUMN IF NOT EXISTS parsed_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS parse_source     VARCHAR(255)
  `);

  // A constrained vocabulary, for the same reason the stage column has one: a
  // free-text qualification means "B.E.", "BE", "B.Tech" and "Bachelor of
  // Engineering" are four different filter values for one degree.
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_qualification_check`);
  await knex.raw(`
    ALTER TABLE candidates
      ADD CONSTRAINT candidates_qualification_check
      CHECK (qualification IS NULL OR qualification IN (${QUALIFICATIONS}))
  `);

  // A graduation year outside living memory is a parse error, not a fact.
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_graduation_year_check`);
  await knex.raw(`
    ALTER TABLE candidates
      ADD CONSTRAINT candidates_graduation_year_check
      CHECK (graduation_year IS NULL OR graduation_year BETWEEN 1950 AND 2100)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_qualification
      ON candidates (company_id, qualification) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_specialisation
      ON candidates (company_id, LOWER(specialisation)) WHERE deleted_at IS NULL
  `);

  // Full-text over the résumé body. english config: stemming means a search for
  // "engineering" also finds "engineer", which is what a recruiter expects.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_resume_text_fts
      ON candidates USING GIN (to_tsvector('english', COALESCE(resume_text, '')))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_resume_text_fts`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_specialisation`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_qualification`);
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_graduation_year_check`);
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_qualification_check`);
  await knex.raw(`
    ALTER TABLE candidates
      DROP COLUMN IF EXISTS qualification,
      DROP COLUMN IF EXISTS specialisation,
      DROP COLUMN IF EXISTS institution,
      DROP COLUMN IF EXISTS graduation_year,
      DROP COLUMN IF EXISTS resume_text,
      DROP COLUMN IF EXISTS parsed_at,
      DROP COLUMN IF EXISTS parse_source
  `);
}
