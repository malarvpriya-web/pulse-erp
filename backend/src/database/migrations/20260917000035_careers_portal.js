/**
 * Careers portal — the public side of recruitment.
 *
 * The audit's Section 1A: "Can candidates apply directly through the company
 * careers page?" No. There was no public route anywhere in the repo, no careers
 * page, and no unauthenticated apply endpoint — every candidate reached the ATS
 * by somebody retyping them into a form.
 *
 * This is the same shape webToLead.routes.js already uses for anonymous web
 * enquiries, because the problem is identical: a write endpoint that has to
 * accept traffic from the open internet.
 *
 *   careers_portals      — one row per company. Holds the revocable KEY, the
 *                          origin allowlist and the hourly cap. Revoking a
 *                          portal is an UPDATE, not a deploy.
 *   careers_applications — every submission, accepted or not. A rejected one is
 *                          the only evidence that a portal is being abused or
 *                          that a real applicant was turned away.
 *
 * Deliberately NOT here: a separate candidate table. A public application
 * creates an ordinary `candidates` row and an ordinary `candidate_applications`
 * row, so an applicant from the website is the same object as one a recruiter
 * typed in — same duplicate guard, same pipeline, same search. A parallel
 * "web applicants" table would have been a second inbox nobody watches.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS careers_portals (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

      -- The public identifier. Random, revocable, and rotatable without a deploy.
      portal_key         VARCHAR(64) NOT NULL UNIQUE,
      is_active          BOOLEAN NOT NULL DEFAULT true,

      -- Shown on the public page.
      display_name       VARCHAR(200),
      intro_text         TEXT,

      -- Empty array = any origin, which someone has to choose deliberately.
      allowed_origins    JSONB NOT NULL DEFAULT '[]'::jsonb,

      -- Counted from careers_applications, so a restart cannot reset it.
      max_per_hour       INTEGER NOT NULL DEFAULT 60,

      -- Salary is hidden by default: a range that is fine internally is a
      -- negotiating position once it is on the open internet.
      show_salary_range  BOOLEAN NOT NULL DEFAULT false,

      -- Every public applicant is stamped with this source, so
      -- source-effectiveness reporting can tell the careers page apart from an
      -- agency or a referral without anyone tagging rows by hand.
      default_source     VARCHAR(30) NOT NULL DEFAULT 'website',

      submission_count   INTEGER NOT NULL DEFAULT 0,
      last_submission_at TIMESTAMPTZ,
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT careers_portals_max_per_hour_check CHECK (max_per_hour BETWEEN 1 AND 10000)
    )
  `);

  // One portal per company. A second key for the same tenant is a second front
  // door to revoke and audit; rotation replaces the key on the existing row.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS careers_portals_one_per_company
      ON careers_portals (company_id)
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS careers_applications (
      id             SERIAL PRIMARY KEY,
      portal_id      INTEGER NOT NULL REFERENCES careers_portals(id) ON DELETE CASCADE,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_opening_id INTEGER REFERENCES job_openings(id) ON DELETE SET NULL,

      -- Set only when the submission produced a real candidate.
      candidate_id   INTEGER REFERENCES candidates(id) ON DELETE SET NULL,

      status         VARCHAR(20) NOT NULL,
      reason         TEXT,

      -- What was actually posted. Keeping it means a wrongly rejected applicant
      -- can be recovered by hand instead of being asked to apply again.
      payload        JSONB,

      ip_address     VARCHAR(64),
      user_agent     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT careers_applications_status_check
        CHECK (status IN ('accepted','duplicate','rejected','rate_limited','spam'))
    )
  `);

  // The hourly cap reads this index on every submission.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_careers_applications_portal_time
      ON careers_applications (portal_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_careers_applications_company
      ON careers_applications (company_id, created_at DESC)
  `);

  // 'careers' joins the candidate source vocabulary so a public application is
  // distinguishable from one a recruiter typed in under source 'website'.
  await knex.raw(`
    ALTER TABLE careers_portals
      DROP CONSTRAINT IF EXISTS careers_portals_default_source_check
  `);
  await knex.raw(`
    ALTER TABLE careers_portals
      ADD CONSTRAINT careers_portals_default_source_check
      CHECK (default_source IN ('website','careers','job_portal','campus','referral'))
  `);
  await knex.raw(`UPDATE careers_portals SET default_source = 'careers' WHERE default_source = 'website'`);
  await knex.raw(`ALTER TABLE careers_portals ALTER COLUMN default_source SET DEFAULT 'careers'`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS careers_applications`);
  await knex.raw(`DROP TABLE IF EXISTS careers_portals`);
}
