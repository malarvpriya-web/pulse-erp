/**
 * 20261013000002 — Internships: a separate workforce population.
 *
 * ── What this adds, and what it deliberately does NOT ────────────────────────
 * TWO new tables, ONE master-data vocabulary and ONE permission module.
 *
 *   interns            NEW. An intern is not an employee: no EMP code, no
 *                      salary assignment, no payroll, no attendance roster, no
 *                      headcount. Putting them in `employees` (even with
 *                      employment_type 'Intern') would count them in every
 *                      register that counts employees — see WORKFORCE_MODEL.md.
 *                      Verified 2026-10-13: no live `employees` row carries
 *                      employment_type 'Intern', so nothing has to move.
 *   intern_documents   NEW, but it is an INDEX, not a store. Bytes go through
 *                      StorageService.uploadFile() — the writer Add Employee and
 *                      BGV use — and are served only by GET /api/files/:name,
 *                      which grows an intern branch in this pass. A filename the
 *                      file route cannot resolve falls through to admin-only, so
 *                      without that branch HR could upload a document and then
 *                      not open it.
 *   master_departments / master_designations
 *                      REUSED by NAME, exactly as employees.department /
 *                      employees.designation are. usage.js counts interns so
 *                      Master Data will not hard-delete a value an intern holds.
 *   master_values      REUSED for INTERNSHIP_TYPE, registered in
 *                      modules/master/vocabularies.js — so the form's picker has
 *                      the same "+ Add new" the employee pickers have.
 *
 * ── Intern ID ────────────────────────────────────────────────────────────────
 * INT001, INT002 … INT1000. The same shape as the company's EMP001 convention
 * (prefix, at least three digits, no hyphen), enforced by a CHECK and unique per
 * company. Minted by shared/internCode.js under a company-scoped advisory lock.
 *
 * ── Duration is GENERATED, not stored by the client ──────────────────────────
 * `duration_days` is computed by the database from the two dates (inclusive), so
 * the list, the filters and the duration report cannot disagree with the dates
 * they were derived from.
 *
 * ── Completion ───────────────────────────────────────────────────────────────
 * Nothing is deleted when an internship ends. Completed requires a completion
 * date; a certificate can only be recorded as issued on a completed internship,
 * and a certificate number only when one was issued.
 */

const INTERN_STATUSES = [
  'Applied', 'Selected', 'Onboarding', 'Active', 'Completed', 'Cancelled', 'Terminated',
];
const STIPEND_FREQUENCIES = ['Monthly', 'Weekly', 'One-time', 'Unpaid'];
const INTERN_DOC_TYPES = [
  'College ID', 'Institution Letter', 'Offer Letter', 'ID Proof', 'Resume',
  'NDA', 'Certificate', 'Other',
];
const TYPE_SEEDS = [
  'Summer Internship', 'Winter Internship', 'Academic / Credit Internship',
  'Industrial Training', 'Project Internship', 'Remote Internship',
];

const list = (arr) => arr.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS interns (
      id                     SERIAL PRIMARY KEY,
      company_id             INTEGER NOT NULL REFERENCES companies(id),
      intern_code            VARCHAR(20) NOT NULL
                               CONSTRAINT interns_code_format CHECK (intern_code ~ '^INT[0-9]{3,}$'),

      first_name             VARCHAR(100) NOT NULL CHECK (BTRIM(first_name) <> ''),
      last_name              VARCHAR(100),
      photo_url              TEXT,
      dob                    DATE,
      gender                 VARCHAR(20),
      personal_email         VARCHAR(200),
      phone                  VARCHAR(20),
      address                TEXT,
      emergency_name         VARCHAR(150),
      emergency_phone        VARCHAR(20),
      emergency_relationship VARCHAR(50),

      college                VARCHAR(200) NOT NULL CHECK (BTRIM(college) <> ''),
      course                 VARCHAR(200) NOT NULL CHECK (BTRIM(course) <> ''),
      specialization         VARCHAR(200),
      current_year           VARCHAR(50),
      graduation_year        INTEGER CHECK (graduation_year IS NULL OR graduation_year BETWEEN 1950 AND 2100),

      department             VARCHAR(150) NOT NULL CHECK (BTRIM(department) <> ''),
      designation            VARCHAR(150) NOT NULL CHECK (BTRIM(designation) <> ''),
      mentor_employee_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      internship_type        VARCHAR(100),
      start_date             DATE NOT NULL,
      end_date               DATE NOT NULL,
      duration_days          INTEGER GENERATED ALWAYS AS (end_date - start_date + 1) STORED,
      status                 VARCHAR(20) NOT NULL DEFAULT 'Selected'
                               CONSTRAINT interns_status_check CHECK (status IN (${list(INTERN_STATUSES)})),
      status_reason          TEXT,

      stipend                NUMERIC(12,2) CHECK (stipend IS NULL OR stipend >= 0),
      stipend_frequency      VARCHAR(20)
                               CONSTRAINT interns_stipend_frequency_check
                               CHECK (stipend_frequency IS NULL OR stipend_frequency IN (${list(STIPEND_FREQUENCIES)})),
      other_benefits         TEXT,

      completed_on           DATE,
      certificate_issued     BOOLEAN NOT NULL DEFAULT false,
      certificate_number     VARCHAR(100),

      notes                  TEXT,
      created_by             INTEGER,
      updated_by             INTEGER,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at             TIMESTAMPTZ,

      CONSTRAINT interns_dates_order CHECK (end_date >= start_date),
      CONSTRAINT interns_completed_needs_date CHECK (status <> 'Completed' OR completed_on IS NOT NULL),
      CONSTRAINT interns_certificate_needs_completion CHECK (NOT certificate_issued OR status = 'Completed'),
      CONSTRAINT interns_certificate_number_needs_issue CHECK (certificate_number IS NULL OR certificate_issued)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS interns_code_company_uniq
      ON interns (company_id, LOWER(intern_code))
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_interns_company_status ON interns (company_id, status) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_interns_company_dates ON interns (company_id, start_date, end_date) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_interns_mentor ON interns (mentor_employee_id) WHERE mentor_employee_id IS NOT NULL`);

  // The mentor must be an employee of the intern's own company. A FK cannot say
  // that; the service checks it first (400) and this is the backstop for every
  // other writer.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION interns_mentor_tenant_guard() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.mentor_employee_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = NEW.mentor_employee_id AND e.company_id = NEW.company_id
      ) THEN
        RAISE EXCEPTION 'mentor % is not an employee of company %', NEW.mentor_employee_id, NEW.company_id
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_interns_mentor_tenant_guard ON interns`);
  await knex.raw(`
    CREATE TRIGGER trg_interns_mentor_tenant_guard
      BEFORE INSERT OR UPDATE OF mentor_employee_id, company_id ON interns
      FOR EACH ROW EXECUTE FUNCTION interns_mentor_tenant_guard()
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS intern_documents (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      intern_id      INTEGER NOT NULL REFERENCES interns(id) ON DELETE RESTRICT,
      doc_type       VARCHAR(40) NOT NULL
                       CONSTRAINT intern_documents_type_check CHECK (doc_type IN (${list(INTERN_DOC_TYPES)})),
      title          VARCHAR(200),
      file_url       TEXT NOT NULL,
      original_name  VARCHAR(255),
      mime_type      VARCHAR(120),
      size_bytes     INTEGER,
      uploaded_by    INTEGER,
      uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_intern_documents_intern ON intern_documents (intern_id) WHERE deleted_at IS NULL`);

  // A document's company must be its intern's company — the same FILL-then-
  // VALIDATE shape the other tenant triggers use, so a writer that omits
  // company_id gets the right one and a writer that supplies the wrong one fails.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION intern_documents_tenant_guard() RETURNS trigger AS $fn$
    DECLARE owner_company INTEGER;
    BEGIN
      SELECT company_id INTO owner_company FROM interns WHERE id = NEW.intern_id;
      IF NEW.company_id IS NULL THEN
        NEW.company_id := owner_company;
      END IF;
      IF NEW.company_id IS DISTINCT FROM owner_company THEN
        RAISE EXCEPTION 'intern document company % does not match intern % (company %)',
          NEW.company_id, NEW.intern_id, owner_company USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_intern_documents_tenant_guard ON intern_documents`);
  await knex.raw(`
    CREATE TRIGGER trg_intern_documents_tenant_guard
      BEFORE INSERT OR UPDATE OF intern_id, company_id ON intern_documents
      FOR EACH ROW EXECUTE FUNCTION intern_documents_tenant_guard()
  `);

  for (let i = 0; i < TYPE_SEEDS.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('INTERNSHIP_TYPE', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [TYPE_SEEDS[i], i + 1]
    );
  }

  // ── Permission matrix ─────────────────────────────────────────────────────
  // requirePermission FAILS CLOSED on a missing row, so every role gets an
  // explicit one: HR/admin tier true, everyone else false. Its own module (not
  // 'employees') because `employee` and `manager` both hold employees:can_view —
  // gating interns on that would show every employee the interns' personal data.
  // Delete is granted to nobody: there is no delete endpoint — an internship
  // ends as Completed / Cancelled / Terminated and its record is kept.
  await knex.raw(`
    INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, 'internships',
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           false,
           false,
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec')
      FROM roles r
     WHERE r.code IS NOT NULL
    ON CONFLICT (role_id, module) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'internships'`);
  await knex.raw(`DELETE FROM master_values WHERE type = 'INTERNSHIP_TYPE' AND company_id IS NULL`);
  await knex.raw(`DROP TABLE IF EXISTS intern_documents`);
  await knex.raw(`DROP FUNCTION IF EXISTS intern_documents_tenant_guard()`);
  await knex.raw(`DROP TABLE IF EXISTS interns`);
  await knex.raw(`DROP FUNCTION IF EXISTS interns_mentor_tenant_guard()`);
}
