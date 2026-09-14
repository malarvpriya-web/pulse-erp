/**
 * 20260908000002_marketing_journeys.js
 *
 * Makes email sequences into journeys that actually run.
 *
 * WHAT WAS ACTUALLY WRONG
 * -----------------------
 * `email_sequences`, `crm_email_sequence_steps` and `sequence_enrollments` all
 * existed and all had rows. Enrolling a lead wrote a row with
 * `next_send_at = NOW()` — and NOTHING EVER READ IT. There was no runner, so no
 * step was ever sent, no enrolment ever advanced past step 0, and the "active
 * enrolments" count on the sequences screen was counting rows that would sit at
 * step 0 forever. The same shape as the workflow engine in §153: a write path
 * with no execution path, which looks identical to a working feature until you
 * ask what came out the other end.
 *
 * WHAT THIS ADDS
 * --------------
 *   - company_id on enrolments (they had none — every runner query would have
 *     been cross-tenant by construction);
 *   - contacts as enrollable, not just leads;
 *   - per-step branching (`send_condition`) and exit conditions, so a journey is
 *     a journey rather than a fixed drip;
 *   - a per-enrolment event log, so "what did this person actually receive" is
 *     answerable — the counter-only design cannot answer it;
 *   - run bookkeeping (`last_run_at`, `attempts`, `last_error`) so a failing
 *     journey is visible instead of quietly stalled.
 *
 * ⚠ TWO STEP TABLES EXIST. `email_sequence_steps` (5 rows) is the older family;
 * the live write path in email.routes.js uses `crm_email_sequence_steps`. This
 * migration extends the LIVE one and marks the other, rather than silently
 * picking one and leaving the ambiguity for the next person.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── enrolments ────────────────────────────────────────────────────────────
  const ENROL = [
    ['company_id', 'INTEGER'],
    ['contact_id', 'INTEGER'],
    ['email', 'VARCHAR(255)'],
    ['last_sent_at', 'TIMESTAMPTZ'],
    ['completed_at', 'TIMESTAMPTZ'],
    ['stopped_at', 'TIMESTAMPTZ'],
    ['stopped_reason', 'TEXT'],
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT'],
    ['enrolled_by', 'INTEGER'],
  ];
  for (const [name, type] of ENROL) {
    await knex.raw(`ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  // Backfill company from the sequence, then from the lead. Rows that resolve to
  // nothing are left NULL and the runner skips them — an unscoped enrolment must
  // never be sent to, because there is no way to know whose customer it is.
  // Two passes, not one. `UPDATE … FROM a LEFT JOIN b ON b.x = e.y` cannot
  // reference the update target inside the FROM's join condition — Postgres
  // rejects it with errorMissingRTE.
  await knex.raw(`
    UPDATE sequence_enrollments e
       SET company_id = s.company_id
      FROM email_sequences s
     WHERE s.id = e.sequence_id AND e.company_id IS NULL AND s.company_id IS NOT NULL
  `);
  await knex.raw(`
    UPDATE sequence_enrollments e
       SET company_id = l.company_id
      FROM leads l
     WHERE l.id = e.lead_id AND e.company_id IS NULL AND l.company_id IS NOT NULL
  `);

  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_status_check') THEN
        ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_status_check
          CHECK (status IN ('active','paused','completed','stopped','failed'));
      END IF;
      -- An enrolment must name SOMEBODY. Both null is a row the runner would
      -- pick up and have no address for.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_subject_check') THEN
        ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_subject_check
          CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL);
      END IF;
    END
    $do$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
      ON sequence_enrollments (status, next_send_at)
     WHERE status = 'active'
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_active_lead
      ON sequence_enrollments (sequence_id, lead_id)
     WHERE status = 'active' AND lead_id IS NOT NULL
  `);

  // ── steps: branching and channel ──────────────────────────────────────────
  const STEPS = [
    ['send_condition', 'JSONB'],
    ['exit_condition', 'JSONB'],
    ['delay_hours', 'INTEGER NOT NULL DEFAULT 0'],
    ['channel', `VARCHAR(20) NOT NULL DEFAULT 'email'`],
    ['is_active', 'BOOLEAN NOT NULL DEFAULT true'],
  ];
  for (const [name, type] of STEPS) {
    await knex.raw(`ALTER TABLE crm_email_sequence_steps ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  // ── sequence-level goal and exit ──────────────────────────────────────────
  const SEQ = [
    ['description', 'TEXT'],
    ['goal_event', 'VARCHAR(60)'],
    ['exit_on_reply', 'BOOLEAN NOT NULL DEFAULT true'],
    ['exit_on_goal', 'BOOLEAN NOT NULL DEFAULT true'],
    ['last_run_at', 'TIMESTAMPTZ'],
  ];
  for (const [name, type] of SEQ) {
    await knex.raw(`ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  // ── what actually happened, per enrolment ─────────────────────────────────
  // A counter says how many; this says which, when, and why not. "Why not" is
  // the half that matters when a journey stalls.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sequence_enrollment_events (
      id            SERIAL PRIMARY KEY,
      enrollment_id INTEGER     NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
      sequence_id   INTEGER     NOT NULL,
      company_id    INTEGER         NULL,
      step_order    INTEGER         NULL,
      event         VARCHAR(30) NOT NULL,
      detail        TEXT            NULL,
      email_id      INTEGER         NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT sequence_event_check CHECK (event IN
        ('enrolled','sent','skipped','condition_failed','paused','resumed',
         'completed','stopped','failed','exited_replied','exited_goal'))
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sequence_events_enrollment
      ON sequence_enrollment_events (enrollment_id, created_at DESC)
  `);

  // ── the abandoned twin ────────────────────────────────────────────────────
  // Left in place and labelled rather than dropped: the CRM duplicate-table
  // families were dropped once before and something still read them.
  await knex.raw(`
    COMMENT ON TABLE email_sequence_steps IS
      'SUPERSEDED 2026-09-08. The live sequence-step table is crm_email_sequence_steps, which is what email.routes.js reads and writes and what the journey runner executes. Retained read-only pending confirmation nothing reads it; do not add columns here.'
  `);

  const { rows: [n] } = await knex.raw(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE company_id IS NULL)::int AS unscoped
       FROM sequence_enrollments`
  );
  console.log(`[marketing_journeys] enrolments=${n.total} unscoped=${n.unscoped}`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS sequence_enrollment_events`);
  await knex.raw(`DROP INDEX IF EXISTS uq_enrollment_active_lead`);
  await knex.raw(`DROP INDEX IF EXISTS idx_sequence_enrollments_due`);
  await knex.raw(`ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_status_check`);
  await knex.raw(`ALTER TABLE sequence_enrollments DROP CONSTRAINT IF EXISTS sequence_enrollments_subject_check`);
  for (const c of ['enrolled_by', 'last_error', 'attempts', 'stopped_reason', 'stopped_at',
                   'completed_at', 'last_sent_at', 'email', 'contact_id', 'company_id']) {
    await knex.raw(`ALTER TABLE sequence_enrollments DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['is_active', 'channel', 'delay_hours', 'exit_condition', 'send_condition']) {
    await knex.raw(`ALTER TABLE crm_email_sequence_steps DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['last_run_at', 'exit_on_goal', 'exit_on_reply', 'goal_event', 'description']) {
    await knex.raw(`ALTER TABLE email_sequences DROP COLUMN IF EXISTS ${c}`);
  }
}
