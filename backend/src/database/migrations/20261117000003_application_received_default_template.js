/**
 * 20261117000003_application_received_default_template.js — recruitment page audit 2026-11-17 (B8).
 *
 * triggerEmail('application_received') had no shared default. The only row was a
 * company test template titled "Test" ("hi {{candidate_name}}"), which is being
 * deleted, and without a default every applicant would get no acknowledgement.
 * This adds the shared default (company_id NULL) alongside the four seeded by
 * 20260917000031/…033. Placeholders are only those the sender fills for this
 * event: candidate_name, job_title.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const SUBJECT = 'We have received your application';
const BODY = `<p>Dear {{candidate_name}},</p>
<p>Thank you for applying{{job_title_phrase}}. We have received your application and our recruitment team will review it.</p>
<p>If your profile matches the role, we will contact you to arrange the next step.</p>
<p>Regards,<br>Recruitment Team</p>`;

export async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM email_templates WHERE company_id IS NULL AND stage_trigger = 'application_received' AND deleted_at IS NULL LIMIT 1`);
  if (rows.length) return;
  await knex.raw(
    `INSERT INTO email_templates
       (template_name, template_type, subject, body_html, name, category, stage_trigger, company_id, module, is_active)
     VALUES ('Application Received', 'application_received', $1, $2, 'Application Received',
             'application_received', 'application_received', NULL, 'recruitment', true)`,
    [SUBJECT, BODY.replace('{{job_title_phrase}}', ' for {{job_title}}')]);
}

export async function down(knex) {
  await knex.raw(
    `DELETE FROM email_templates WHERE company_id IS NULL AND stage_trigger = 'application_received' AND template_name = 'Application Received'`);
}
