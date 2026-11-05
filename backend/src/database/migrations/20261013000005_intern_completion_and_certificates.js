/**
 * 20261013000005 — Internship completion gate, certificate register, lifecycle audit.
 *
 * Inspected before writing (2026-10-13): ONE intern exists (company 1, INT001,
 * Active), with no completion date, no certificate, no certificate document and
 * no evaluation. Nothing here backfills, completes, certifies or rewrites a row;
 * the guards below fire only on a CHANGE, so any historical row is left as it is.
 *
 * ADDS
 *   interns.completion_evaluation_id   the approved evaluation a completion
 *                                      rested on. NULL for every existing row.
 *   intern_certificates                one row per certificate EVER issued.
 *                                      Number unique per company across issued
 *                                      AND revoked rows (a revoked number is never
 *                                      reissued); at most one unrevoked per intern.
 *                                      interns.certificate_issued / _number stay as
 *                                      the display copy of the active row.
 *   intern_audit_events                completed / certificate_issued /
 *                                      certificate_revoked, company-scoped, with
 *                                      actor, reason and details. UPDATE refused.
 *   trg_interns_completion_guard       the database half of the API's rules:
 *     - an intern cannot be INSERTED as Completed or with a certificate;
 *     - Completed cannot be left;
 *     - entering Completed needs completion_evaluation_id pointing at this
 *       intern's LATEST evaluation, Approved, recommending Confirm Completion;
 *     - certificate_issued = true needs a matching unrevoked certificate row,
 *       and an unrevoked certificate cannot be dropped from the intern without
 *       revoking it first.
 */

const AUDIT_ACTIONS = ['completed', 'certificate_issued', 'certificate_revoked'];
const list = (arr) => arr.map(v => `'${v}'`).join(', ');

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE interns
      ADD COLUMN IF NOT EXISTS completion_evaluation_id INTEGER
        REFERENCES intern_evaluations(id) ON DELETE SET NULL
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_certificates (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL REFERENCES companies(id),
      intern_id            INTEGER NOT NULL REFERENCES interns(id) ON DELETE RESTRICT,
      certificate_number   VARCHAR(100) NOT NULL CHECK (BTRIM(certificate_number) <> ''),
      document_id          INTEGER REFERENCES intern_documents(id) ON DELETE SET NULL,
      issued_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      issued_by_user_id    INTEGER,
      revoked_at           TIMESTAMPTZ,
      revoked_by_user_id   INTEGER,
      revoke_reason        TEXT,
      CONSTRAINT intern_certificates_revoke_complete CHECK (
        revoked_at IS NULL
        OR (revoked_by_user_id IS NOT NULL AND NULLIF(BTRIM(revoke_reason), '') IS NOT NULL))
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_intern_certificates_company_number
      ON intern_certificates (company_id, LOWER(BTRIM(certificate_number)))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_intern_certificates_one_active
      ON intern_certificates (intern_id) WHERE revoked_at IS NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION intern_certificates_tenant_guard() RETURNS trigger AS $fn$
    DECLARE owner_company INTEGER;
    BEGIN
      SELECT company_id INTO owner_company FROM interns WHERE id = NEW.intern_id;
      IF NEW.company_id IS NULL THEN NEW.company_id := owner_company; END IF;
      IF NEW.company_id IS DISTINCT FROM owner_company THEN
        RAISE EXCEPTION 'certificate company % does not match intern % (company %)',
          NEW.company_id, NEW.intern_id, owner_company USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_intern_certificates_tenant_guard ON intern_certificates`);
  await knex.raw(`
    CREATE TRIGGER trg_intern_certificates_tenant_guard
      BEFORE INSERT OR UPDATE OF intern_id, company_id ON intern_certificates
      FOR EACH ROW EXECUTE FUNCTION intern_certificates_tenant_guard()
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_audit_events (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL REFERENCES companies(id),
      intern_id        INTEGER NOT NULL,
      action           VARCHAR(30) NOT NULL
                         CONSTRAINT intern_audit_events_action_check CHECK (action IN (${list(AUDIT_ACTIONS)})),
      actor_user_id    INTEGER,
      evaluation_id    INTEGER,
      certificate_id   INTEGER,
      reason           TEXT,
      details          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_intern_audit_events_intern ON intern_audit_events (company_id, intern_id, id)`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION intern_audit_events_immutable() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'intern_audit_events is append-only' USING ERRCODE = '55000';
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_intern_audit_events_immutable ON intern_audit_events`);
  await knex.raw(`
    CREATE TRIGGER trg_intern_audit_events_immutable
      BEFORE UPDATE ON intern_audit_events
      FOR EACH ROW EXECUTE FUNCTION intern_audit_events_immutable()
  `);

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
        RETURN NEW;
      END IF;

      IF OLD.status = 'Completed' AND NEW.status <> 'Completed' THEN
        RAISE EXCEPTION 'a completed internship cannot change status (to %)', NEW.status USING ERRCODE = '23514';
      END IF;

      IF NEW.status = 'Completed' AND OLD.status <> 'Completed' THEN
        SELECT id, status, recommendation INTO latest
          FROM intern_evaluations WHERE intern_id = NEW.id ORDER BY id DESC LIMIT 1;
        IF latest.id IS NULL OR latest.id IS DISTINCT FROM NEW.completion_evaluation_id
           OR latest.status <> 'Approved' OR latest.recommendation <> 'Confirm Completion' THEN
          RAISE EXCEPTION 'completion needs the latest evaluation of intern % approved and recommending completion', NEW.id
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
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_interns_completion_guard ON interns`);
  await knex.raw(`
    CREATE TRIGGER trg_interns_completion_guard
      BEFORE INSERT OR UPDATE OF status, certificate_issued, certificate_number, completion_evaluation_id ON interns
      FOR EACH ROW EXECUTE FUNCTION interns_completion_guard()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_interns_completion_guard ON interns`);
  await knex.raw(`DROP FUNCTION IF EXISTS interns_completion_guard()`);
  await knex.raw(`DROP TABLE IF EXISTS intern_audit_events`);
  await knex.raw(`DROP FUNCTION IF EXISTS intern_audit_events_immutable()`);
  await knex.raw(`DROP TABLE IF EXISTS intern_certificates`);
  await knex.raw(`DROP FUNCTION IF EXISTS intern_certificates_tenant_guard()`);
  await knex.raw(`ALTER TABLE interns DROP COLUMN IF EXISTS completion_evaluation_id`);
}
