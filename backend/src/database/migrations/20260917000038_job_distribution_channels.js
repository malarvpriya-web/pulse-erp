/**
 * Job distribution — where a role has been advertised, and how it got there.
 *
 * The audit's Section 2 asked the system to "track job posting status across
 * platforms". It could not: there was no record anywhere of where a job had
 * been advertised, so a recruiter closing a role had no list of the places they
 * needed to take it down from.
 *
 * ── THE HONEST SHAPE OF THIS PROBLEM ────────────────────────────────────────
 * Of the channels the brief names, exactly one can be automated without signing
 * something first:
 *
 *   careers   — this system's own public page. Automatic, already built.
 *   indeed    — an XML job feed Indeed polls. Free, no partner agreement, and
 *               the only third-party channel buildable from here. Built.
 *   linkedin  — requires LinkedIn Talent Solutions ATS partner certification.
 *   naukri    — requires a paid Naukri RMS agreement.
 *   foundit   — requires a commercial API agreement.
 *
 * So this table does two different jobs and is explicit about which is which.
 * For `careers` and `indeed` it RECORDS what the system did. For the rest it is
 * a manual checklist: a recruiter who posts to LinkedIn by hand marks it here,
 * with the URL, so that the take-down list is complete and
 * source-effectiveness reporting has something true to join against.
 *
 * Calling a manual checkbox an "integration" is exactly what the audit warned
 * against, so `posting_mode` names it on every row.
 */

const CHANNELS = `'careers','indeed','linkedin','naukri','foundit','other'`;
const STATUSES = `'draft','posted','expired','removed','failed'`;
const MODES    = `'automatic','feed','manual'`;

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS job_distributions (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_opening_id  INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,

      channel         VARCHAR(20) NOT NULL,
      status          VARCHAR(20) NOT NULL DEFAULT 'draft',

      -- How the posting reaches the channel. 'automatic' = this system serves it
      -- directly (careers page); 'feed' = we publish it and the channel collects
      -- it (Indeed XML); 'manual' = a person posted it and ticked this box.
      -- Naming the mode on the row is what stops a checklist entry being read
      -- as an integration.
      posting_mode    VARCHAR(20) NOT NULL DEFAULT 'manual',

      external_url    TEXT,
      external_ref    VARCHAR(200),
      posted_at       TIMESTAMPTZ,
      removed_at      TIMESTAMPTZ,
      last_error      TEXT,
      notes           TEXT,

      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT job_distributions_channel_check CHECK (channel IN (${CHANNELS})),
      CONSTRAINT job_distributions_status_check  CHECK (status  IN (${STATUSES})),
      CONSTRAINT job_distributions_mode_check    CHECK (posting_mode IN (${MODES}))
    )
  `);

  // One row per job per channel — a second "posted to LinkedIn" row for the
  // same role is a duplicate, not a second posting.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS job_distributions_unique
      ON job_distributions (job_opening_id, channel)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_job_distributions_company
      ON job_distributions (company_id, channel, status)
  `);

  // Whether a role is included in the Indeed feed. Opt-in per job: a
  // confidential replacement hire must not be syndicated to a job board because
  // somebody forgot to untick something.
  await knex.raw(`
    ALTER TABLE job_openings
      ADD COLUMN IF NOT EXISTS include_in_feed BOOLEAN NOT NULL DEFAULT false
  `);

  // Backfill: every currently-open role already advertised on the careers page
  // gets its 'careers' row, so the tracker is not empty on the day it ships.
  await knex.raw(`
    INSERT INTO job_distributions (company_id, job_opening_id, channel, status, posting_mode, posted_at)
    SELECT jo.company_id, jo.id, 'careers', 'posted', 'automatic', COALESCE(jo.posted_date::timestamptz, NOW())
      FROM job_openings jo
      JOIN careers_portals cp ON cp.company_id = jo.company_id AND cp.is_active
     WHERE jo.deleted_at IS NULL
       AND LOWER(jo.status) = 'open'
       AND jo.company_id IS NOT NULL
    ON CONFLICT (job_opening_id, channel) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE job_openings DROP COLUMN IF EXISTS include_in_feed`);
  await knex.raw(`DROP TABLE IF EXISTS job_distributions`);
}
