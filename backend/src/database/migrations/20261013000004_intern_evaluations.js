/**
 * 20261013000004 — Intern mentor evaluation and HR review.
 *
 * ADDS
 *   intern_evaluations        one evaluation per (intern, mentor) cycle:
 *                             Draft -> Submitted -> Approved, or
 *                             Submitted -> Returned -> (revised) -> Submitted.
 *   intern_evaluation_events  the audit trail: every save, submit, approve and
 *                             return, with actor, timestamps, decision, reason and
 *                             a snapshot. UPDATE is refused by trigger — history
 *                             is appended, never rewritten.
 *   role_permissions          internships.can_approve = true for the HR roles that
 *                             review (super_admin, admin, hr, hr_manager). The
 *                             flag was false for every role and read by nothing;
 *                             it now gates the review endpoint. hr_exec keeps
 *                             view/add/edit and does NOT approve.
 *
 * DOES NOT
 *   touch interns, their statuses, certificates or documents; create any
 *   evaluation for an existing intern; or approve anything. Completion is not
 *   yet gated on an approved evaluation — that is a later change.
 *
 * Evaluator identity is an EMPLOYEE (the intern's mentor), and the submitting /
 * reviewing USER ids are recorded separately — they are different tables and
 * confusing users.id with employees.id is a recurring bug here. No FK to users:
 * interns.created_by has none either, and a removed login must not erase the
 * record of who signed off.
 */

const RECOMMENDATIONS = ['Confirm Completion', 'Extend Internship', 'Do Not Recommend Completion'];
const STATUSES = ['Draft', 'Submitted', 'Returned', 'Approved'];
const EVENT_ACTIONS = ['created', 'saved', 'submitted', 'returned', 'approved'];
const list = (arr) => arr.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_evaluations (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER NOT NULL REFERENCES companies(id),
      intern_id             INTEGER NOT NULL REFERENCES interns(id) ON DELETE RESTRICT,
      mentor_employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      comments              TEXT,
      recommendation        VARCHAR(40)
                              CONSTRAINT intern_evaluations_recommendation_check
                              CHECK (recommendation IS NULL OR recommendation IN (${list(RECOMMENDATIONS)})),
      status                VARCHAR(20) NOT NULL DEFAULT 'Draft'
                              CONSTRAINT intern_evaluations_status_check CHECK (status IN (${list(STATUSES)})),
      created_by_user_id    INTEGER,
      submitted_by_user_id  INTEGER,
      submitted_at          TIMESTAMPTZ,
      reviewed_by_user_id   INTEGER,
      reviewed_at           TIMESTAMPTZ,
      return_reason         TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- A submitted or approved evaluation states its case and who sent it.
      CONSTRAINT intern_evaluations_submitted_complete CHECK (
        status NOT IN ('Submitted', 'Approved')
        OR (recommendation IS NOT NULL AND NULLIF(BTRIM(comments), '') IS NOT NULL
            AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)),
      -- A decision names its reviewer; a return names its reason.
      CONSTRAINT intern_evaluations_reviewed_complete CHECK (
        status NOT IN ('Approved', 'Returned')
        OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
      CONSTRAINT intern_evaluations_return_reason CHECK (
        status <> 'Returned' OR NULLIF(BTRIM(return_reason), '') IS NOT NULL),
      -- The submitter is never the reviewer.
      CONSTRAINT intern_evaluations_no_self_review CHECK (
        reviewed_by_user_id IS NULL OR submitted_by_user_id IS NULL
        OR reviewed_by_user_id <> submitted_by_user_id)
    )
  `);
  // One OPEN evaluation per intern per mentor. An approved one is closed, so a
  // later cycle (after an extension, say) can start a new one.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_intern_evaluations_open
      ON intern_evaluations (intern_id, mentor_employee_id)
      WHERE status IN ('Draft', 'Submitted', 'Returned')
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_intern_evaluations_company_status ON intern_evaluations (company_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_intern_evaluations_mentor ON intern_evaluations (mentor_employee_id)`);

  // FILL then VALIDATE the tenant from the intern, the same shape as
  // intern_documents_tenant_guard.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION intern_evaluations_tenant_guard() RETURNS trigger AS $fn$
    DECLARE owner_company INTEGER;
    BEGIN
      SELECT company_id INTO owner_company FROM interns WHERE id = NEW.intern_id;
      IF NEW.company_id IS NULL THEN
        NEW.company_id := owner_company;
      END IF;
      IF NEW.company_id IS DISTINCT FROM owner_company THEN
        RAISE EXCEPTION 'evaluation company % does not match intern % (company %)',
          NEW.company_id, NEW.intern_id, owner_company USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM employees e
                      WHERE e.id = NEW.mentor_employee_id AND e.company_id = NEW.company_id) THEN
        RAISE EXCEPTION 'mentor % is not an employee of company %', NEW.mentor_employee_id, NEW.company_id
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_intern_evaluations_tenant_guard ON intern_evaluations`);
  await knex.raw(`
    CREATE TRIGGER trg_intern_evaluations_tenant_guard
      BEFORE INSERT OR UPDATE OF intern_id, company_id, mentor_employee_id ON intern_evaluations
      FOR EACH ROW EXECUTE FUNCTION intern_evaluations_tenant_guard()
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_evaluation_events (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id),
      evaluation_id       INTEGER NOT NULL REFERENCES intern_evaluations(id) ON DELETE RESTRICT,
      intern_id           INTEGER NOT NULL,
      action              VARCHAR(20) NOT NULL
                            CONSTRAINT intern_evaluation_events_action_check CHECK (action IN (${list(EVENT_ACTIONS)})),
      from_status         VARCHAR(20),
      to_status           VARCHAR(20) NOT NULL,
      actor_user_id       INTEGER,
      actor_employee_id   INTEGER,
      reason              TEXT,
      snapshot            JSONB NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_intern_evaluation_events_eval ON intern_evaluation_events (evaluation_id, id)`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION intern_evaluation_events_immutable() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'intern_evaluation_events is append-only' USING ERRCODE = '55000';
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_intern_evaluation_events_immutable ON intern_evaluation_events`);
  await knex.raw(`
    CREATE TRIGGER trg_intern_evaluation_events_immutable
      BEFORE UPDATE ON intern_evaluation_events
      FOR EACH ROW EXECUTE FUNCTION intern_evaluation_events_immutable()
  `);

  await knex.raw(`
    UPDATE role_permissions rp SET can_approve = true
      FROM roles r
     WHERE r.id = rp.role_id AND rp.module = 'internships'
       AND LOWER(r.code) IN ('super_admin', 'admin', 'hr', 'hr_manager')
  `);
}

export async function down(knex) {
  await knex.raw(`UPDATE role_permissions SET can_approve = false WHERE module = 'internships'`);
  await knex.raw(`DROP TABLE IF EXISTS intern_evaluation_events`);
  await knex.raw(`DROP FUNCTION IF EXISTS intern_evaluation_events_immutable()`);
  await knex.raw(`DROP TABLE IF EXISTS intern_evaluations`);
  await knex.raw(`DROP FUNCTION IF EXISTS intern_evaluations_tenant_guard()`);
}
