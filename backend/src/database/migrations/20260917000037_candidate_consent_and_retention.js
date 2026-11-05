/**
 * Candidate consent and data retention.
 *
 * The audit's Section 11, and the one remaining item with legal weight rather
 * than commercial. Until now the ATS recorded nothing about WHY it was allowed
 * to hold a candidate's personal data or for HOW LONG. The careers page showed a
 * plain-language notice at the point of application, which is the right place
 * for it, but the fact that it was shown and accepted was stored nowhere — so
 * the system could not answer "on what basis are you holding this person's
 * details", and there was no mechanism to ever stop.
 *
 * India's DPDP Act 2023 is the reason this is not optional for a customer
 * shipping here, but the shape below is jurisdiction-neutral: a lawful basis, a
 * timestamp, the text that was actually agreed to, and an expiry.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ───────────────────────────────────────────
 * Nothing is deleted by this migration, and no existing candidate is given a
 * retention date. Back-dating consent onto records collected before consent was
 * captured would be inventing evidence, and a retention clock started
 * retroactively could purge a live candidate mid-pipeline on the day it ships.
 * Existing rows get `consent_basis = 'legacy'`, which the purge job ignores and
 * a report can count. Somebody has to make a decision about them; this schema
 * makes it possible to see how many there are.
 *
 * ── WHY A SEPARATE consent_text ─────────────────────────────────────────────
 * Storing the wording that was on screen, not just a boolean, is the difference
 * between "they ticked something" and "here is what they agreed to". The notice
 * will be edited over time; a record that points at today's wording cannot
 * evidence what last year's applicant saw.
 */

const BASES = `'consent','legitimate_interest','contract','legacy'`;

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE candidates
      ADD COLUMN IF NOT EXISTS consent_basis   VARCHAR(30),
      ADD COLUMN IF NOT EXISTS consent_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS consent_text    TEXT,
      ADD COLUMN IF NOT EXISTS consent_source  VARCHAR(40),
      ADD COLUMN IF NOT EXISTS retain_until    DATE,
      -- A withdrawal is not a deletion: the person may still be mid-pipeline,
      -- and the request itself has to be evidenced. The purge job treats a
      -- withdrawn record as due immediately.
      ADD COLUMN IF NOT EXISTS consent_withdrawn_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS anonymised_at   TIMESTAMPTZ
  `);

  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_consent_basis_check`);
  await knex.raw(`
    ALTER TABLE candidates
      ADD CONSTRAINT candidates_consent_basis_check
      CHECK (consent_basis IS NULL OR consent_basis IN (${BASES}))
  `);

  // Everything already in the pipeline predates consent capture. Marked as such
  // rather than back-dated — see the header.
  await knex.raw(`
    UPDATE candidates
       SET consent_basis = 'legacy'
     WHERE consent_basis IS NULL AND deleted_at IS NULL
  `);

  // The purge job scans on this every night.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_retain_until
      ON candidates (retain_until)
     WHERE retain_until IS NOT NULL AND anonymised_at IS NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidates_consent_withdrawn
      ON candidates (consent_withdrawn_at)
     WHERE consent_withdrawn_at IS NOT NULL AND anonymised_at IS NULL
  `);

  /**
   * The log of what the purge actually did.
   *
   * A retention policy that runs silently is indistinguishable from one that is
   * broken. This is also the only evidence that a deletion request was honoured,
   * which is the thing a regulator asks for — and it deliberately records the
   * candidate id and nothing identifying, so the log itself does not become a
   * copy of the data it just erased.
   */
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS candidate_retention_log (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id   INTEGER,
      action         VARCHAR(20) NOT NULL,
      reason         VARCHAR(60),
      retain_until   DATE,
      triggered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT candidate_retention_log_action_check
        CHECK (action IN ('anonymised','extended','withdrawn','exported'))
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_candidate_retention_log_company
      ON candidate_retention_log (company_id, created_at DESC)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS candidate_retention_log`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_consent_withdrawn`);
  await knex.raw(`DROP INDEX IF EXISTS idx_candidates_retain_until`);
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_consent_basis_check`);
  await knex.raw(`
    ALTER TABLE candidates
      DROP COLUMN IF EXISTS consent_basis,
      DROP COLUMN IF EXISTS consent_at,
      DROP COLUMN IF EXISTS consent_text,
      DROP COLUMN IF EXISTS consent_source,
      DROP COLUMN IF EXISTS retain_until,
      DROP COLUMN IF EXISTS consent_withdrawn_at,
      DROP COLUMN IF EXISTS anonymised_at
  `);
}
