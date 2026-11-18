/**
 * 20261117000007_careers_portal_website_url.js — the company's own careers page (2026-11-17).
 *
 * Owner decision: candidates apply on the company website (Manifest), not on a
 * Pulse-hosted page. The Job Openings tab was removed from Jobs; the Careers
 * Website tab stores the address of the company's careers page so staff can
 * copy and share it, and so the origin allowlist can be set from it.
 *
 * The website lists jobs from GET /api/v1/public/careers/:key and posts the
 * form to .../apply/:jobId — the job id is what links an applicant to a job.
 * The URL stored here links nothing by itself.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE careers_portals ADD COLUMN IF NOT EXISTS website_url varchar(500)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE careers_portals DROP COLUMN IF EXISTS website_url`);
}
