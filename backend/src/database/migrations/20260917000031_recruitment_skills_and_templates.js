/**
 * Two recruitment data-integrity repairs.
 *
 * 1. candidates.skills must be a jsonb ARRAY.
 *
 *    createCandidate() ran JSON.stringify(skills) unconditionally. On the
 *    multipart path multer delivers every field as a string, so an already-JSON
 *    string was stringified a second time and stored as a jsonb STRING SCALAR
 *    ("[\"React\"]") instead of an array (["React"]).
 *
 *    That is not a cosmetic difference. GET /talent/resumes/skills runs
 *    jsonb_array_elements_text() across every candidate in the company; a single
 *    scalar row makes it raise "cannot extract elements from a scalar", so the
 *    skill-filter chips in the Resume Database return HTTP 500 for every user of
 *    that tenant until somebody finds and repairs the row by hand.
 *
 *    The repository now normalises before insert, but that only protects rows
 *    written from here on. This migration repairs any already stored, then adds
 *    the CHECK constraint that makes the shape enforceable at the database rather
 *    than relying on every future write path remembering.
 *
 * 2. Seed the three recruitment email templates that had no row.
 *
 *    triggerEmail() fires four events — application_received, offer_sent,
 *    interview_rejected, hired_welcome — and returns silently at
 *    `if (!tmpl.rows.length) return`. Only application_received had a template,
 *    so offer delivery and candidate rejection mailed nobody and reported
 *    nothing. Seeded per company, inactive-safe, and skipped where a company has
 *    already written its own template for that trigger.
 */

export async function up(knex) {
  // ── 1a. Repair scalar/blank skills ────────────────────────────────────────
  // A jsonb string scalar holding JSON text is re-parsed back into the array it
  // was always meant to be. Anything else non-array (a bare string, a number)
  // becomes a single-element array, which is the honest reading of the value.
  await knex.raw(`
    UPDATE candidates
       SET skills = CASE
             WHEN jsonb_typeof(skills) = 'string'
              AND LEFT(BTRIM(skills #>> '{}'), 1) = '['
             THEN (BTRIM(skills #>> '{}'))::jsonb
             WHEN jsonb_typeof(skills) = 'string'
              AND BTRIM(skills #>> '{}') <> ''
             THEN jsonb_build_array(BTRIM(skills #>> '{}'))
             ELSE '[]'::jsonb
           END
     WHERE skills IS NOT NULL
       AND jsonb_typeof(skills) <> 'array'
  `);

  // Anything the CASE above could not turn into an array (malformed JSON inside
  // a string scalar) would still fail the constraint. Fall back to empty rather
  // than block the migration on one bad row.
  await knex.raw(`
    UPDATE candidates SET skills = '[]'::jsonb
     WHERE skills IS NOT NULL AND jsonb_typeof(skills) <> 'array'
  `);

  // ── 1b. Make the shape enforceable ────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_skills_is_array
  `);
  await knex.raw(`
    ALTER TABLE candidates
      ADD CONSTRAINT candidates_skills_is_array
      CHECK (skills IS NULL OR jsonb_typeof(skills) = 'array')
  `);

  // `tags` is the same jsonb-array shape and the same accident waiting to
  // happen the day something starts writing it.
  await knex.raw(`
    UPDATE candidates SET tags = '[]'::jsonb
     WHERE tags IS NOT NULL AND jsonb_typeof(tags) <> 'array'
  `);
  await knex.raw(`
    ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_tags_is_array
  `);
  await knex.raw(`
    ALTER TABLE candidates
      ADD CONSTRAINT candidates_tags_is_array
      CHECK (tags IS NULL OR jsonb_typeof(tags) = 'array')
  `);

  // ── 2. Seed the missing recruitment email templates ───────────────────────
  // Placeholders use the {{name}} form triggerEmail() substitutes, and only the
  // keys each call site actually passes.
  const templates = [
    {
      trigger: 'offer_sent',
      name:    'Offer Letter Sent',
      subject: 'Your offer from {{company_name}}',
      body:    `<p>Dear {{candidate_name}},</p>
<p>We are pleased to offer you the position of <strong>{{job_title}}</strong>.</p>
<p>Your formal offer letter is attached. Please review it and confirm your acceptance by <strong>{{offer_expiry_date}}</strong>.</p>
<p>We are looking forward to working with you.</p>
<p>Talent Acquisition</p>`,
    },
    {
      trigger: 'interview_rejected',
      name:    'Application Not Progressing',
      subject: 'Update on your application',
      body:    `<p>Dear {{candidate_name}},</p>
<p>Thank you for taking the time to interview with us. After careful consideration we will not be moving forward with your application at this stage.</p>
<p>{{rejection_reason}}</p>
<p>We genuinely appreciate your interest and will keep your details on file for future openings that match your experience.</p>
<p>Talent Acquisition</p>`,
    },
    {
      trigger: 'hired_welcome',
      name:    'Welcome Aboard',
      subject: 'Welcome to the team, {{candidate_name}}',
      body:    `<p>Dear {{candidate_name}},</p>
<p>Congratulations, and welcome. We are delighted that you have accepted the role of <strong>{{job_title}}</strong>.</p>
<p>Your joining date is <strong>{{joining_date}}</strong>. A member of the HR team will be in touch shortly with your onboarding details and the documents to bring on your first day.</p>
<p>Talent Acquisition</p>`,
    },
  ];

  // Seeded ONCE with company_id NULL rather than per company. triggerEmail()
  // already resolves `company_id = $n OR company_id IS NULL` and orders
  // `company_id NULLS LAST`, so an unscoped row is the fallback every tenant
  // inherits while any company that writes its own template still wins. Seeding
  // per company instead produced a row for every companies record on the
  // database — including abandoned test tenants — for no behavioural gain.
  for (const t of templates) {
    // Positional $n, never '?' — this project's migration runner is a thin pg
    // shim, not knex's own query builder, so '?' reaches Postgres verbatim.
    // Every parameter in a SELECT target list carries an explicit cast:
    // Postgres has no column to infer a bare $n's type from there and fails
    // the statement at parse time ("could not determine data type").
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
      [t.name, t.trigger, t.subject, t.body]
    );
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_skills_is_array`);
  await knex.raw(`ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_tags_is_array`);
  await knex.raw(`
    DELETE FROM email_templates
     WHERE module = 'recruitment'
       AND stage_trigger IN ('offer_sent', 'interview_rejected', 'hired_welcome')
  `);
}
