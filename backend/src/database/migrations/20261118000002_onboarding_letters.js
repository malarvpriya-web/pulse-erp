/**
 * 20261118000002 — joining letters are issued at onboarding and kept on the
 * employee's record.
 *
 * Owner, 18 Nov 26: at offer stage only the offer e-mail goes to the candidate
 * (no letter attached). The offer letter, appointment letter and
 * confidentiality letter are issued during onboarding and saved with the
 * employee's documents (Add / Edit Employee → Upload Documents).
 *
 *   employees.appointment_letter_file, employees.confidentiality_letter_file —
 *     two more document slots beside offer_letter_file. They hold the CURRENT
 *     copy: the issued PDF, or the signed scan HR uploads over it.
 *   employee_letter_issues — every letter issued, with who and when, so a
 *     re-issue does not lose the earlier copy.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() drops the table and the two columns.
 */
export const OFFER_MAIL_BODY = [
  '<p>Dear {{candidate_name}},</p>',
  '<p>We are pleased to offer you the position of <strong>{{job_title}}</strong> at {{company_name}}, with an annual cost to company (CTC) of <strong>{{ctc}}</strong>.</p>',
  '<p>Proposed joining date: <strong>{{joining_date}}</strong>.</p>',
  '<p>Please reply to this e-mail to confirm your acceptance by <strong>{{offer_expiry_date}}</strong>. Your offer letter, appointment letter and other joining documents will be given to you when you join.</p>',
  '<p>We are looking forward to working with you.</p>',
  '<p>Talent Acquisition</p>',
].join('\n');

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS appointment_letter_file     VARCHAR(500),
      ADD COLUMN IF NOT EXISTS confidentiality_letter_file VARCHAR(500)
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_letter_issues (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL REFERENCES companies(id),
      employee_id  INTEGER NOT NULL REFERENCES employees(id),
      letter_type  VARCHAR(30) NOT NULL
                   CHECK (letter_type IN ('offer', 'appointment', 'confidentiality')),
      file_url     VARCHAR(500) NOT NULL,
      reference    VARCHAR(60),
      issued_by    INTEGER REFERENCES users(id),
      issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS employee_letter_issues_emp_idx
                    ON employee_letter_issues (employee_id, letter_type, issued_at DESC)`);
  // The offer e-mail no longer carries the letter, so the wording that says it
  // is attached is replaced — only where that sentence is still there, so a
  // company's own rewrite is left alone.
  await knex.raw(`
    UPDATE email_templates
       SET body_html = $1, updated_at = NOW()
     WHERE stage_trigger = 'offer_sent' AND deleted_at IS NULL
       AND body_html LIKE '%offer letter is attached%'`, [OFFER_MAIL_BODY]);
  // The app connects as pulse_app (least privilege, 11-05): grant like other tables.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN
        GRANT SELECT, INSERT ON employee_letter_issues TO pulse_app;
        GRANT USAGE, SELECT ON SEQUENCE employee_letter_issues_id_seq TO pulse_app;
      END IF;
    END $$`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS employee_letter_issues`);
  await knex.raw(`
    ALTER TABLE employees
      DROP COLUMN IF EXISTS appointment_letter_file,
      DROP COLUMN IF EXISTS confidentiality_letter_file
  `);
}
