/**
 * 20261013000006 — Internship completion & conversion workflow.
 *
 * Inspected before writing (2026-10-13): one intern (company 1, INT001, Active),
 * ZERO intern_evaluations rows, ZERO certificates. document_templates holds 5
 * SEED rows, none tenant-owned. Nothing below backfills or rewrites a row.
 *
 * ADDS
 *   document_templates.company_id / owner_module / template_key / heading /
 *   signatory_name / signatory_title / updated_by
 *                      The EXISTING template table, reused rather than a second
 *                      one. A row with owner_module set belongs to that module
 *                      and one company; the generic /documents/templates routes
 *                      (no tenant filter, no write gate) now skip such rows —
 *                      documents.repository.js — so an employee cannot read or
 *                      rewrite a company's certificate wording through them.
 *                      No row is seeded: a company with no row of its own gets
 *                      the built-in default (shared/internshipTemplates.js).
 *   intern_evaluations
 *     ratings          technical_skills, communication, teamwork,
 *                      discipline_attendance, learning_ability,
 *                      overall_performance — 1..5, all six required to submit.
 *     recommendation   NEW vocabulary (the mentor's view on employment):
 *                      Recommended for Employment / Not Recommended /
 *                      Extend Internship / Need Further Review. There are no
 *                      rows, so nothing is mapped.
 *     request tracking requested_by_user_id, request_sent_at, reminder_count,
 *                      last_reminder_at, received_at, received_via
 *                      (Online | Document), evaluation_document_id (the returned
 *                      form, an intern_documents row of type 'Mentor Evaluation').
 *   intern_evaluation_events.action  + requested, reminded, received, document_attached
 *   intern_documents.doc_type        + 'Mentor Evaluation'
 *   interns.converted_employee_id / converted_at / converted_by_user_id
 *   interns.project_work_area        the "Project / Work Area" both documents name
 *   employees.source_intern_id       unique — one employee per internship
 *   intern_audit_events.action       + converted_to_employee
 *   trg_interns_completion_guard     completion now needs the latest evaluation
 *                                    Approved and recommending employment or
 *                                    "Not Recommended" (the internship itself was
 *                                    served); Extend / Need Further Review block it.
 *                                    Conversion columns are write-once.
 */

const RECOMMENDATIONS = ['Recommended for Employment', 'Not Recommended', 'Extend Internship', 'Need Further Review'];
const COMPLETING = ['Recommended for Employment', 'Not Recommended'];
const EVENT_ACTIONS = ['created', 'saved', 'submitted', 'returned', 'approved',
  'requested', 'reminded', 'received', 'document_attached'];
const DOC_TYPES = ['College ID', 'Institution Letter', 'Offer Letter', 'ID Proof', 'Resume', 'NDA',
  'Certificate', 'Other', 'Mentor Evaluation'];
const AUDIT_ACTIONS = ['completed', 'certificate_issued', 'certificate_revoked', 'converted_to_employee'];
const RATINGS = ['technical_skills', 'communication', 'teamwork', 'discipline_attendance',
  'learning_ability', 'overall_performance'];
const list = (arr) => arr.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');

export async function up(knex) {
  // ── Templates: the existing table, tenant-owned rows ──────────────────────
  await knex.raw(`
    ALTER TABLE document_templates
      ADD COLUMN IF NOT EXISTS company_id      INTEGER REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS owner_module    VARCHAR(40),
      ADD COLUMN IF NOT EXISTS template_key    VARCHAR(60),
      ADD COLUMN IF NOT EXISTS heading         VARCHAR(200),
      ADD COLUMN IF NOT EXISTS signatory_name  VARCHAR(150),
      ADD COLUMN IF NOT EXISTS signatory_title VARCHAR(150),
      ADD COLUMN IF NOT EXISTS updated_by      INTEGER
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_document_templates_module_key
      ON document_templates (company_id, owner_module, template_key)
      WHERE deleted_at IS NULL AND owner_module IS NOT NULL
  `);
  await knex.raw(`
    ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_module_owned_complete;
    ALTER TABLE document_templates ADD CONSTRAINT document_templates_module_owned_complete CHECK (
      owner_module IS NULL OR (company_id IS NOT NULL AND template_key IS NOT NULL))
  `);

  // ── Evaluation: ratings, vocabulary, request tracking ─────────────────────
  await knex.raw(`
    ALTER TABLE intern_evaluations
      ${RATINGS.map(c => `ADD COLUMN IF NOT EXISTS ${c} SMALLINT CHECK (${c} IS NULL OR ${c} BETWEEN 1 AND 5)`).join(',\n      ')},
      ADD COLUMN IF NOT EXISTS requested_by_user_id   INTEGER,
      ADD COLUMN IF NOT EXISTS request_sent_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reminder_count         INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
      ADD COLUMN IF NOT EXISTS last_reminder_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS received_at            TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS received_via           VARCHAR(20)
                               CHECK (received_via IS NULL OR received_via IN ('Online', 'Document')),
      ADD COLUMN IF NOT EXISTS evaluation_document_id INTEGER REFERENCES intern_documents(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE intern_evaluations DROP CONSTRAINT IF EXISTS intern_evaluations_recommendation_check;
    ALTER TABLE intern_evaluations ADD CONSTRAINT intern_evaluations_recommendation_check
      CHECK (recommendation IS NULL OR recommendation IN (${list(RECOMMENDATIONS)}));
    ALTER TABLE intern_evaluations DROP CONSTRAINT IF EXISTS intern_evaluations_submitted_complete;
    ALTER TABLE intern_evaluations ADD CONSTRAINT intern_evaluations_submitted_complete CHECK (
      status NOT IN ('Submitted', 'Approved')
      OR (recommendation IS NOT NULL AND NULLIF(BTRIM(comments), '') IS NOT NULL
          AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL
          AND received_at IS NOT NULL AND received_via IS NOT NULL
          AND ${RATINGS.map(c => `${c} IS NOT NULL`).join(' AND ')}));
    ALTER TABLE intern_evaluations DROP CONSTRAINT IF EXISTS intern_evaluations_reminder_after_send;
    ALTER TABLE intern_evaluations ADD CONSTRAINT intern_evaluations_reminder_after_send CHECK (
      reminder_count = 0 OR request_sent_at IS NOT NULL)
  `);
  await knex.raw(`
    ALTER TABLE intern_evaluation_events DROP CONSTRAINT IF EXISTS intern_evaluation_events_action_check;
    ALTER TABLE intern_evaluation_events ADD CONSTRAINT intern_evaluation_events_action_check
      CHECK (action IN (${list(EVENT_ACTIONS)}))
  `);
  await knex.raw(`
    ALTER TABLE intern_documents DROP CONSTRAINT IF EXISTS intern_documents_type_check;
    ALTER TABLE intern_documents ADD CONSTRAINT intern_documents_type_check CHECK (doc_type IN (${list(DOC_TYPES)}))
  `);

  // ── Conversion links, both directions ─────────────────────────────────────
  await knex.raw(`
    ALTER TABLE interns
      ADD COLUMN IF NOT EXISTS converted_employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS converted_at          TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS converted_by_user_id  INTEGER,
      ADD COLUMN IF NOT EXISTS project_work_area     TEXT
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_interns_converted_employee
      ON interns (converted_employee_id) WHERE converted_employee_id IS NOT NULL
  `);
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS source_intern_id INTEGER REFERENCES interns(id) ON DELETE RESTRICT`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_source_intern
      ON employees (source_intern_id) WHERE source_intern_id IS NOT NULL
  `);
  await knex.raw(`
    ALTER TABLE intern_audit_events DROP CONSTRAINT IF EXISTS intern_audit_events_action_check;
    ALTER TABLE intern_audit_events ADD CONSTRAINT intern_audit_events_action_check CHECK (action IN (${list(AUDIT_ACTIONS)}))
  `);

  // ── Completion guard: new vocabulary + write-once conversion ──────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION interns_completion_guard() RETURNS trigger AS $fn$
    DECLARE latest RECORD;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'Completed' THEN
          RAISE EXCEPTION 'an internship cannot be created as Completed' USING ERRCODE = '23514';
        END IF;
        IF NEW.certificate_issued THEN
          RAISE EXCEPTION 'an internship cannot be created with a certificate' USING ERRCODE = '23514';
        END IF;
        IF NEW.converted_employee_id IS NOT NULL THEN
          RAISE EXCEPTION 'an internship cannot be created as already converted' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'Completed' AND NEW.status <> 'Completed' THEN
        RAISE EXCEPTION 'a completed internship cannot change status (to %)', NEW.status USING ERRCODE = '23514';
      END IF;

      IF NEW.status = 'Completed' AND OLD.status <> 'Completed' THEN
        SELECT id, status, recommendation INTO latest
          FROM intern_evaluations WHERE intern_id = NEW.id ORDER BY id DESC LIMIT 1;
        IF latest.id IS NULL OR latest.id IS DISTINCT FROM NEW.completion_evaluation_id
           OR latest.status <> 'Approved' OR latest.recommendation NOT IN (${list(COMPLETING)}) THEN
          RAISE EXCEPTION 'completion needs the latest evaluation of intern % approved, recommending employment or not', NEW.id
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.certificate_issued AND NOT EXISTS (
           SELECT 1 FROM intern_certificates c
            WHERE c.intern_id = NEW.id AND c.revoked_at IS NULL
              AND c.certificate_number = NEW.certificate_number) THEN
        RAISE EXCEPTION 'intern % has no issued certificate %', NEW.id, NEW.certificate_number USING ERRCODE = '23514';
      END IF;
      IF NOT NEW.certificate_issued AND EXISTS (
           SELECT 1 FROM intern_certificates c WHERE c.intern_id = NEW.id AND c.revoked_at IS NULL) THEN
        RAISE EXCEPTION 'intern % has an unrevoked certificate; revoke it first', NEW.id USING ERRCODE = '23514';
      END IF;

      IF OLD.converted_employee_id IS NOT NULL
         AND NEW.converted_employee_id IS DISTINCT FROM OLD.converted_employee_id THEN
        RAISE EXCEPTION 'intern % is already converted to employee %', NEW.id, OLD.converted_employee_id USING ERRCODE = '23514';
      END IF;
      IF NEW.converted_employee_id IS NOT NULL AND OLD.converted_employee_id IS NULL THEN
        IF NEW.status <> 'Completed' THEN
          RAISE EXCEPTION 'only a completed internship can be converted' USING ERRCODE = '23514';
        END IF;
        SELECT id, status, recommendation INTO latest
          FROM intern_evaluations WHERE intern_id = NEW.id ORDER BY id DESC LIMIT 1;
        IF latest.id IS NULL OR latest.status <> 'Approved' OR latest.recommendation <> 'Recommended for Employment' THEN
          RAISE EXCEPTION 'conversion needs the latest evaluation of intern % approved and recommending employment', NEW.id
            USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM employees e
                        WHERE e.id = NEW.converted_employee_id AND e.company_id = NEW.company_id) THEN
          RAISE EXCEPTION 'employee % is not in company %', NEW.converted_employee_id, NEW.company_id USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_interns_completion_guard ON interns`);
  await knex.raw(`
    CREATE TRIGGER trg_interns_completion_guard
      BEFORE INSERT OR UPDATE OF status, certificate_issued, certificate_number, completion_evaluation_id,
                                 converted_employee_id ON interns
      FOR EACH ROW EXECUTE FUNCTION interns_completion_guard()
  `);
}

export async function down(knex) {
  // The guard references the conversion columns; put back the previous one first.
  await knex.raw(`DROP TRIGGER IF EXISTS trg_interns_completion_guard ON interns`);
  await knex.raw(`DROP INDEX IF EXISTS ux_employees_source_intern`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS source_intern_id`);
  await knex.raw(`DROP INDEX IF EXISTS ux_interns_converted_employee`);
  await knex.raw(`ALTER TABLE interns DROP COLUMN IF EXISTS converted_employee_id, DROP COLUMN IF EXISTS converted_at,
                  DROP COLUMN IF EXISTS converted_by_user_id, DROP COLUMN IF EXISTS project_work_area`);
  await knex.raw(`ALTER TABLE intern_evaluations DROP CONSTRAINT IF EXISTS intern_evaluations_reminder_after_send`);
  await knex.raw(`ALTER TABLE intern_evaluations
    ${RATINGS.map(c => `DROP COLUMN IF EXISTS ${c}`).join(', ')},
    DROP COLUMN IF EXISTS requested_by_user_id, DROP COLUMN IF EXISTS request_sent_at,
    DROP COLUMN IF EXISTS reminder_count, DROP COLUMN IF EXISTS last_reminder_at,
    DROP COLUMN IF EXISTS received_at, DROP COLUMN IF EXISTS received_via,
    DROP COLUMN IF EXISTS evaluation_document_id`);
  await knex.raw(`DROP INDEX IF EXISTS ux_document_templates_module_key`);
  await knex.raw(`ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_module_owned_complete`);
  await knex.raw(`DELETE FROM document_templates WHERE owner_module IS NOT NULL`);
  await knex.raw(`ALTER TABLE document_templates DROP COLUMN IF EXISTS company_id, DROP COLUMN IF EXISTS owner_module,
                  DROP COLUMN IF EXISTS template_key, DROP COLUMN IF EXISTS heading,
                  DROP COLUMN IF EXISTS signatory_name, DROP COLUMN IF EXISTS signatory_title,
                  DROP COLUMN IF EXISTS updated_by`);
  // Re-creates 20261013000005's guard function and trigger (idempotent DDL).
  const previous = await import('./20261013000005_intern_completion_and_certificates.js');
  await previous.up(knex);
}
