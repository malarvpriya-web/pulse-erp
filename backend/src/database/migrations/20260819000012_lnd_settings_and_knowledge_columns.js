/**
 * L&D settings and Knowledge documents — the columns their screens write.
 *
 * Both are complete, mounted CRUD features whose tables were created with a
 * narrower column set than the code writes, so every save threw 42703:
 *
 *  • `PUT /hr/lnd-settings` upserts 12 columns; `lnd_settings` had two of them
 *    under different names (pass_score_default, cert_reminder_days) and was
 *    missing the other ten. The GET already returns hardcoded defaults when no
 *    row exists, which is why the screen looked functional — it was showing
 *    defaults and silently failing to persist anything.
 *
 *  • `POST /hr/knowledge` writes description, content, file_url,
 *    applicable_departments, applicable_roles, review_due_date and
 *    created_by_employee_id. `knowledge_documents` had none of them (it carries
 *    content_url / drive_url / reviewed_at instead).
 *
 * The route bodies are the specification here — these are settings and document
 * metadata with no other home, so the columns are added rather than the writes
 * being remapped onto unrelated existing ones.
 *
 * Existing near-name columns are kept and backfilled from, not dropped: other
 * readers may still use them.
 */

export async function up(knex) {
  // ── L&D settings ──────────────────────────────────────────────────────────
  const lnd = [
    ['default_pass_score',            'integer DEFAULT 70'],
    ['reminder_days_before',          'integer DEFAULT 3'],
    ['cert_expiry_reminder_days',     'integer DEFAULT 30'],
    ['enable_email_notifications',    'boolean NOT NULL DEFAULT true'],
    ['enable_manager_notifications',  'boolean NOT NULL DEFAULT true'],
    ['mandatory_training_freq_days',  'integer DEFAULT 365'],
    ['feedback_required',             'boolean NOT NULL DEFAULT false'],
    ['min_feedback_chars',            'integer DEFAULT 0'],
    ['allow_self_enrollment',         'boolean NOT NULL DEFAULT true'],
    ['max_concurrent_enrollments',    'integer DEFAULT 5'],
  ];
  for (const [n, t] of lnd) {
    await knex.raw(`ALTER TABLE lnd_settings ADD COLUMN IF NOT EXISTS ${n} ${t};`);
  }
  // Carry the equivalents that already existed under other names.
  await knex.raw(`UPDATE lnd_settings SET default_pass_score        = pass_score_default  WHERE pass_score_default IS NOT NULL;`);
  // NOT backfilled from cert_reminder_days: that column is an integer ARRAY (a
  // list of reminder offsets, e.g. {30,15,7}) while the screen writes a single
  // integer. Different concepts that happen to have similar names — copying one
  // into the other would be a type error and, worse, a silent meaning change.

  // ── Knowledge documents ───────────────────────────────────────────────────
  const kd = [
    ['description',              'text'],
    ['content',                  'text'],
    ['file_url',                 'text'],
    ['applicable_departments',   'text[]'],
    ['applicable_roles',         'text[]'],
    ['review_due_date',          'date'],
    ['created_by_employee_id',   'integer REFERENCES employees(id) ON DELETE SET NULL'],
    ['updated_by_employee_id',   'integer REFERENCES employees(id) ON DELETE SET NULL'],
    ['view_count',               'integer NOT NULL DEFAULT 0'],
  ];
  for (const [n, t] of kd) {
    await knex.raw(`ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS ${n} ${t};`);
  }
  await knex.raw(`UPDATE knowledge_documents SET file_url = content_url WHERE content_url IS NOT NULL AND file_url IS NULL;`);
}

export async function down(knex) {
  for (const c of ['description','content','file_url','applicable_departments','applicable_roles',
                   'review_due_date','created_by_employee_id','updated_by_employee_id','view_count']) {
    await knex.raw(`ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS ${c};`);
  }
  for (const c of ['default_pass_score','reminder_days_before','cert_expiry_reminder_days',
                   'enable_email_notifications','enable_manager_notifications',
                   'mandatory_training_freq_days','feedback_required','min_feedback_chars',
                   'allow_self_enrollment','max_concurrent_enrollments']) {
    await knex.raw(`ALTER TABLE lnd_settings DROP COLUMN IF EXISTS ${c};`);
  }
}
