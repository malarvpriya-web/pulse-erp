/**
 * The fifth recruitment email trigger.
 *
 * Migration 20260917000031 seeded templates for offer_sent, interview_rejected
 * and hired_welcome — the three that a grep for `triggerEmail('<lowercase>')`
 * turned up as having no row. That pattern missed `interview_l1_scheduled`,
 * because the trigger name contains a digit.
 *
 * It surfaced the moment emailTrigger.js started logging the sends it was
 * abandoning: scheduling an interview immediately wrote
 * "No active email template for trigger interview_l1_scheduled". That is the
 * whole argument for the logging change — a silent early-return is indexed by
 * nothing, while a warning finds the case a regex did not.
 *
 * Placeholders match exactly the keys POST /recruitment/interviews passes:
 * candidate_name, interview_date, interview_mode.
 */

export async function up(knex) {
  await knex.raw(
    `INSERT INTO email_templates
       (name, template_name, category, template_type, stage_trigger,
        subject, body_html, is_active, company_id, module)
     SELECT $1::varchar, $1::text, $2::varchar, $2::varchar, $2::varchar,
            $3::text, $4::text, true, NULL, 'recruitment'
      WHERE NOT EXISTS (
        SELECT 1 FROM email_templates
         WHERE (stage_trigger = $2 OR category = $2)
           AND company_id IS NULL
           AND deleted_at IS NULL
      )`,
    [
      'Interview Scheduled',
      'interview_l1_scheduled',
      'Your interview is scheduled for {{interview_date}}',
      `<p>Dear {{candidate_name}},</p>
<p>Thank you for your interest. We would like to invite you to an interview.</p>
<p><strong>Date:</strong> {{interview_date}}<br><strong>Format:</strong> {{interview_mode}}</p>
<p>If this time does not work for you, reply to this email and we will find another.</p>
<p>Talent Acquisition</p>`,
    ]
  );
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM email_templates
     WHERE module = 'recruitment' AND stage_trigger = 'interview_l1_scheduled'
  `);
}
