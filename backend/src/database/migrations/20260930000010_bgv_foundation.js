/**
 * 20260930000010 — Employee Background Verification (BGV) foundation.
 *
 * ── What this adds, and what it deliberately does NOT ────────────────────────
 * FIVE new tables and ONE master-data vocabulary. Nothing else. In particular
 * there is no new employee table, no second document-storage mechanism and no
 * second file server:
 *
 *   employees              REUSED. A BGV case hangs off `employees.id`; the
 *                          Employee ID shown in the UI is `employees.office_id`
 *                          (the EMP001 series), and department / designation /
 *                          joining_date are read from that row. Nothing about
 *                          an employee is copied here.
 *   StorageService         REUSED. Report bytes go through uploadFile(), the
 *                          same writer Add Employee and the Documents tab use.
 *   GET /api/files/:name   REUSED. Reports are served only through the
 *                          authenticated, audit-logged route, never through a
 *                          public /uploads URL. secureFiles.routes.js grows a
 *                          `bgv_documents` ownership branch in this pass — a
 *                          filename it cannot resolve falls through to
 *                          admin-only, so without that branch HR could upload
 *                          a report and then not be able to open it.
 *   master_values          REUSED for the check-type vocabulary. Seeded below
 *                          as type 'BGV_CHECK_TYPE' with a registry entry in
 *                          modules/master/vocabularies.js — a row in a list,
 *                          not a sixth table. Check types are therefore
 *                          user-extensible from Master Data, which is what the
 *                          brief asked for instead of a hardcoded array.
 *
 * ── Why bgv_agencies is a new table and not recruitment_agencies ─────────────
 * `recruitment_agencies` already exists, and it is NOT this. Its columns are
 * commission_pct, fee_percentage, agreement_start / agreement_end,
 * specializations, payment_terms: it models a STAFFING agency that supplies
 * candidates and is paid a percentage of a placed salary. A BGV vendor is paid
 * a fee per check and is described by GSTIN and the set of check types it can
 * perform. Filing both in one table would leave every column of each kind NULL
 * for the other, and would make the recruitment Agency Management screen list
 * verification vendors as candidate sources. The procurement `vendors` master
 * was the other candidate and was rejected for the opposite reason: it carries
 * vendor codes, categories and an approval workflow, so adding a BGV agency
 * would require procurement permission for what is an HR act.
 *
 * ── Why four of these tables carry NO company_id ─────────────────────────────
 * bgv_cases / bgv_checks / bgv_check_contacts / bgv_documents deliberately have
 * no company_id column. Every one of them is reachable from exactly one
 * `employees` row, and `employees.company_id` is already the answer. A copy of
 * the tenant id on four more tables is four more places for it to drift, and
 * [[project_company_id_null_scoping_gotcha]] is what a drifted or NULL copy
 * does to the standard `($1::int IS NULL OR company_id = $1)` predicate: it
 * fails OPEN. Scoping joins `employees` instead, which cannot be wrong because
 * it is the same row the employee record itself is filed under.
 *
 * `bgv_agencies` DOES carry company_id — it has no employee to hang off, and a
 * verification vendor is tenant-private data (rates, contacts, GSTIN).
 *
 * ── Status and Result are two columns, on purpose ────────────────────────────
 * The brief listed one vocabulary — Pending, Initiated, In Progress, Completed,
 * Clear, Discrepancy, Unable to Verify, Cancelled — and then said "Do not
 * assume that Completed means Clear. Result and status must remain separate."
 * Those two sentences cannot both be satisfied by one column, so that list is
 * split across the two axes it actually describes:
 *
 *   status  — where the WORK is:  Pending · Initiated · In Progress ·
 *                                 Completed · Cancelled
 *   result  — what it FOUND:      Pending · Clear · Discrepancy ·
 *                                 Unable to Verify
 *
 * A check can therefore be Completed/Discrepancy, Completed/Unable to Verify or
 * Completed/Clear, and "verification finished" is never readable as "candidate
 * cleared". The API additionally refuses status='Completed' while result is
 * still 'Pending', so closing a check forces someone to state the outcome.
 *
 * ── The case has no status column ────────────────────────────────────────────
 * There is no `bgv_cases.status`. A stored aggregate of the checks below it is a
 * second source of truth that drifts the moment a check is edited by a path
 * which forgets to recompute it — the failure behind
 * [[project_employees_dashboard_rebuild_2026-09-27]] (three status vocabularies
 * disagreeing about one employee) and
 * [[project_ceo_dashboard_cross_section_consistency]]. Case status is DERIVED
 * from the checks by one SQL expression (CASE_STATUS_SQL in bgv.routes.js) that
 * the list, the dashboard KPIs and the detail page all share, so the three
 * cannot disagree. The only stored lifecycle fact is `closed_at`, because
 * "Closed" is an explicit HR act and not something the checks can imply.
 *
 * ── Cost: NULL is not zero ───────────────────────────────────────────────────
 * amount / tax_amount are NULLable with NO default.
 * [[project_tco_freight_inputs_never_captured]] is what `DEFAULT 0` does to a
 * money column: "not captured yet" and "free of charge" become the same value
 * and no report can tell them apart. total_amount is GENERATED so the stored
 * total can never disagree with its parts, and it is NULL — not 0 — while both
 * parts are unset.
 */

export async function up(knex) {
  // ⚠ `knex` here is the pg shim, not knex: bindings are $1/$2, never the
  // question mark, which Postgres parses as the jsonb-exists operator. See
  // [[project_migration_runner_pg_shim]]. And no backticks inside SQL text —
  // [[project_backtick_in_sql_comment_breaks_boot]].

  // ── Agencies ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bgv_agencies (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agency_name     VARCHAR(200) NOT NULL,
      contact_person  VARCHAR(150),
      email           VARCHAR(200),
      phone           VARCHAR(30),
      address         TEXT,
      website         VARCHAR(255),
      gstin           VARCHAR(15),
      services        JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      notes           TEXT,
      created_by      INTEGER,
      updated_by      INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Case-INSENSITIVE uniqueness per tenant. An exact-case unique index lets
  // 'ABC Verification' and 'abc verification' both in, and then half the spend
  // reports under each — the defect
  // [[project_master_data_governance_2026-09-29]] found on five master tables.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bgv_agencies_company_name
      ON bgv_agencies (company_id, LOWER(BTRIM(agency_name)))
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_agencies_company ON bgv_agencies (company_id)`);

  // ── Cases: exactly one per employee ────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bgv_cases (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      primary_agency_id INTEGER REFERENCES bgv_agencies(id) ON DELETE SET NULL,
      initiated_on      DATE,
      closed_at         TIMESTAMPTZ,
      closed_by         INTEGER,
      closure_remarks   TEXT,
      remarks           TEXT,
      created_by        INTEGER,
      updated_by        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // "Each employee should have one BGV case" — expressed as a constraint, not a
  // convention, so a double-click on "Start BGV" cannot make a second case that
  // splits the employee's checks and spend across two records.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bgv_cases_employee ON bgv_cases (employee_id)
  `);

  // ── Checks ─────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bgv_checks (
      id              SERIAL PRIMARY KEY,
      case_id         INTEGER NOT NULL REFERENCES bgv_cases(id) ON DELETE CASCADE,
      check_type      VARCHAR(100) NOT NULL,
      agency_id       INTEGER REFERENCES bgv_agencies(id) ON DELETE SET NULL,
      contact_person  VARCHAR(150),
      contact_email   VARCHAR(200),
      contact_phone   VARCHAR(30),
      request_date    DATE,
      expected_date   DATE,
      completed_date  DATE,
      status          VARCHAR(30) NOT NULL DEFAULT 'Pending',
      result          VARCHAR(30) NOT NULL DEFAULT 'Pending',
      remarks         TEXT,
      amount          NUMERIC(12,2),
      tax_amount      NUMERIC(12,2),
      total_amount    NUMERIC(12,2) GENERATED ALWAYS AS (
                        CASE WHEN amount IS NULL AND tax_amount IS NULL THEN NULL
                             ELSE COALESCE(amount, 0) + COALESCE(tax_amount, 0) END
                      ) STORED,
      invoice_number  VARCHAR(100),
      payment_date    DATE,
      payment_status  VARCHAR(20) NOT NULL DEFAULT 'Pending',
      cost_remarks    TEXT,
      followup_on     DATE,
      followup_owner  VARCHAR(150),
      followup_notes  TEXT,
      created_by      INTEGER,
      updated_by      INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bgv_checks_status_chk
        CHECK (status IN ('Pending','Initiated','In Progress','Completed','Cancelled')),
      CONSTRAINT bgv_checks_result_chk
        CHECK (result IN ('Pending','Clear','Discrepancy','Unable to Verify')),
      CONSTRAINT bgv_checks_payment_status_chk
        CHECK (payment_status IN ('Pending','Invoiced','Paid','Waived'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_checks_case ON bgv_checks (case_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_checks_agency ON bgv_checks (agency_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_checks_status ON bgv_checks (status, result)`);

  // ── Contact / communication history — APPEND ONLY ──────────────────────────
  // "This should create a history rather than overwriting previous contact
  // attempts." There is no UPDATE or DELETE endpoint for this table; a second
  // attempt to reach the same employer is a second row.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bgv_check_contacts (
      id             SERIAL PRIMARY KEY,
      check_id       INTEGER NOT NULL REFERENCES bgv_checks(id) ON DELETE CASCADE,
      contact_type   VARCHAR(50) NOT NULL,
      contact_person VARCHAR(150),
      organization   VARCHAR(200),
      phone          VARCHAR(30),
      email          VARCHAR(200),
      contacted_on   DATE,
      method         VARCHAR(20) NOT NULL DEFAULT 'Phone',
      response       VARCHAR(20) NOT NULL DEFAULT 'Pending',
      notes          TEXT,
      created_by     INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bgv_contacts_method_chk
        CHECK (method IN ('Phone','Email','Portal','Visit','Other')),
      CONSTRAINT bgv_contacts_response_chk
        CHECK (response IN ('Pending','Received','No Response','Discrepancy'))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_contacts_check ON bgv_check_contacts (check_id)`);

  // ── Report documents ──────────────────────────────────────────────────────
  // check_id is NOT NULL: a BGV report always belongs to the check that
  // produced it. That is what keeps the folder view meaningful and what lets
  // secureFiles resolve a filename back to an employee and a company.
  //
  // These rows are NOT in `employee_documents`, and that is a security decision
  // rather than a modelling preference: the self-service documents API lets an
  // employee list their own employee_documents rows, and a criminal-record or
  // reference-check report is precisely the document its subject must not be
  // able to pull. Same storage, same download route, separate index.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bgv_documents (
      id            SERIAL PRIMARY KEY,
      check_id      INTEGER NOT NULL REFERENCES bgv_checks(id) ON DELETE CASCADE,
      document_type VARCHAR(100) NOT NULL DEFAULT 'Verification Report',
      document_name VARCHAR(300) NOT NULL,
      file_url      TEXT NOT NULL,
      file_size     INTEGER,
      notes         TEXT,
      uploaded_by   INTEGER,
      uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bgv_documents_check ON bgv_documents (check_id)`);

  // ── Check-type vocabulary (master_values, not a table) ────────────────────
  // company_id NULL = shared seed, exactly as the BANK vocabulary does. A
  // tenant that needs a check type not listed here adds it through
  // "+ Add new..." and that row lands with THEIR company_id.
  const CHECK_TYPES = [
    'Identity Verification',
    'Address Verification',
    'Employment Verification',
    'Education Verification',
    'Criminal/Court Check',
    'Reference Check',
    'Professional Reference',
    'Document Verification',
    'Other',
  ];
  for (let i = 0; i < CHECK_TYPES.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('BGV_CHECK_TYPE', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [CHECK_TYPES[i], i + 1],
    );
  }

  // ── Permission matrix ─────────────────────────────────────────────────────
  // requirePermission FAILS CLOSED on a missing row (PERMISSION_NOT_CONFIGURED),
  // so an unseeded role gets a 403 that reads like a bug. Every role gets an
  // EXPLICIT row — true for the HR/admin tier, false for everyone else — so the
  // denial for a sales_exec is a recorded decision rather than an omission.
  //
  // ⚠ `employees` itself has rows for only six of the 26 roles, which is why
  // hr_manager / hr_exec are named here explicitly: they hold no `employees`
  // row at all, and gating BGV without seeding them would 403 the two roles the
  // module exists for. That is the
  // [[project_pulse01_env_write_rbac_killswitch]] lesson — the gate has to name
  // the role the page was built for — applied before the fact.
  //
  // can_approve stays false for everyone: BGV has no approval step, and a flag
  // nothing reads is the [[project_comp_off_flag_noop_and_silent_catches]] trap.
  await knex.raw(`
    INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
    SELECT r.id, 'bgv',
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec'),
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager'),
           false,
           LOWER(r.code) IN ('super_admin','admin','hr','hr_manager','hr_exec')
      FROM roles r
     WHERE r.code IS NOT NULL
    ON CONFLICT (role_id, module) DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'bgv'`);
  // Only the shared seed. A tenant's own added check types survive — dropping
  // them would orphan the checks that reference them by name.
  await knex.raw(`DELETE FROM master_values WHERE type = 'BGV_CHECK_TYPE' AND company_id IS NULL`);
  await knex.raw(`DROP TABLE IF EXISTS bgv_documents`);
  await knex.raw(`DROP TABLE IF EXISTS bgv_check_contacts`);
  await knex.raw(`DROP TABLE IF EXISTS bgv_checks`);
  await knex.raw(`DROP TABLE IF EXISTS bgv_cases`);
  await knex.raw(`DROP TABLE IF EXISTS bgv_agencies`);
}
